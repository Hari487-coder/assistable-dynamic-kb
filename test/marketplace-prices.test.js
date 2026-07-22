import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { parseRangeLike, parseNumericLike, inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { deriveIntent } from "../src/search/intent.js";
import { searchStructured } from "../src/search/structured.js";
import { buildToolResponse } from "../src/search/respond.js";

// The shape a live scrap-price marketplace actually publishes: one row per
// yard per grade, prices as BANDS per kilo, some yards not yet priced.
const YARDS = [
  ["Sullivans Metal Recycling", "London", "Bright Wire", "£8.20 – £8.70"],
  ["Sullivans Metal Recycling", "London", "Copper Piping", "£7.90 – £8.30"],
  ["MetalCom Scrap Metal", "London", "Bright Wire", "£8.00 – £8.95"],
  ["MetalCom Scrap Metal", "London", "Copper Piping", "£7.50 – £8.10"],
  ["EMR Edmonton", "London", "Bright Wire", "£7.70 – £7.80"],
  ["EMR Edmonton", "London", "Copper Piping", "£7.20 – £7.40"],
  ["Peak Copper Prices", "Manchester", "Bright Wire", "£8.10 – £8.60"],
  ["Peak Copper Prices", "Manchester", "Copper Piping", "£7.80 – £8.00"],
  ["New Yard Ltd", "Leeds", "Bright Wire", "POA"],          // listed, not yet priced
  ["New Yard Ltd", "Leeds", "Copper Piping", "call for price"],
];
const ROWS = YARDS.map(([yard_name, area, grade, price_per_kg]) => ({ yard_name, area, grade, price_per_kg }));

test("price bands parse: dashes, en/em dashes, and 'to'", () => {
  assert.deepEqual(parseRangeLike("£8.20 – £8.70"), { from: 8.2, to: 8.7 });
  assert.deepEqual(parseRangeLike("£6.00 — £8.50"), { from: 6, to: 8.5 });
  assert.deepEqual(parseRangeLike("9 to 10"), { from: 9, to: 10 });
  assert.deepEqual(parseRangeLike("10 to 10.50"), { from: 10, to: 10.5 });
  assert.deepEqual(parseRangeLike("£1.00-£2.00"), { from: 1, to: 2 });
  // Not ranges: dates, negatives, plain numbers, prose with a stray dash
  assert.equal(parseRangeLike("2026-07-22"), null);
  assert.equal(parseRangeLike("-5"), null);
  assert.equal(parseRangeLike("£7.20"), null);
  assert.equal(parseRangeLike("No. 1 Copper - Clean"), null);
});

test("'POA'/'call for price' count as missing, not as text", () => {
  for (const marker of ["POA", "p.o.a.", "call for price", "TBC", "on request", "—", "N/A"]) {
    assert.equal(parseNumericLike(marker), null, `${marker} must parse as missing`);
  }
  const meta = inferColumnMeta(ROWS);
  const price = meta.find((c) => c.name === "price_per_kg");
  assert.equal(price.kind, "numeric", "20% unpriced yards must not demote the price column to text");
  assert.equal(price.isRange, true);
  assert.equal(price.currency, "£");
  assert.equal(price.unit, "per kilo");
  assert.equal(price.min, 7.2, "min is the lowest band floor");
  assert.equal(price.max, 8.95, "max is the highest band ceiling");
});

test("a banded row keeps both a comparable number and its real ends", () => {
  const meta = inferColumnMeta(ROWS);
  const item = rowToItem(ROWS[0], meta);
  assert.equal(item.structured.price_per_kg, 8.45, "midpoint drives filters and sorting");
  assert.deepEqual(item.structured.price_per_kg_range, [8.2, 8.7], "the published band survives for the answer");
  const unpriced = rowToItem(ROWS[8], meta);
  assert.equal(unpriced.structured.price_per_kg, null);
  assert.equal(unpriced.structured.price_per_kg_range, undefined);
});

function seed() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')").run();
  const meta = inferColumnMeta(ROWS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','database','Yard prices','ct','sec','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of ROWS) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  return { db, meta, source: db.prepare("SELECT * FROM sources WHERE id='s1'").get() };
}

test("the answer quotes the published band, per kilo, in pounds", () => {
  const { db, source } = seed();
  const structured = searchStructured(db, source, { query: "bright wire at sullivans" });
  const out = buildToolResponse({ source, structured, args: {}, tookMs: 1 });
  assert.match(out.speech_hint, /£8\.20 to £8\.70 per kilo/,
    `expected a banded per-kilo quote, got: ${out.speech_hint}`);
  assert.ok(!out.speech_hint.includes("$"), "a £ marketplace must never be spoken in dollars");
  assert.ok(!/8\.45/.test(out.speech_hint), "never invent a midpoint figure the yard never published");
});

test("'who pays the most' sorts high-to-low (sell-side vocabulary)", () => {
  const { db, meta, source } = seed();
  assert.deepEqual(deriveIntent("who pays the most for bright wire", meta).sort,
    { col: "price_per_kg", dir: "desc" });
  assert.deepEqual(deriveIntent("highest paying yard near me", meta).sort,
    { col: "price_per_kg", dir: "desc" });
  const r = searchStructured(db, source, { query: "who pays the most for bright wire", filters: {} });
  assert.equal(r.items[0].structured.yard_name, "MetalCom Scrap Metal",
    "MetalCom's 8.00-8.95 band has the highest midpoint of the Bright Wire rows");
});

test("unpriced yards never lead a price answer", () => {
  const { db, source } = seed();
  const r = searchStructured(db, source, { query: "cheapest copper piping", filters: {} });
  assert.ok(r.items.every((i) => i.structured.price_per_kg !== null),
    "a yard with no published price is not an offer");
});

test("a listed-but-unpriced yard is disclosed, not presented as an offer", () => {
  const { db, source } = seed();
  const structured = searchStructured(db, source, { query: "bright wire at new yard ltd" });
  const out = buildToolResponse({ source, structured, args: {}, tookMs: 1 });
  assert.match(out.speech_hint, /no price published yet/i,
    `an unpriced yard must be flagged so the model can't invent a rate: ${out.speech_hint}`);
});

test("titles name the row, not its postcode or contact details", () => {
  const rows = ROWS.map((r, i) => ({ ...r, postcode: `SE${i} 6NX`, whatsapp: `wa.me/44${i}`, active: "true" }));
  const meta = inferColumnMeta(rows);
  const title = rowToItem(rows[0], meta).title;
  assert.ok(title.includes("Sullivans Metal Recycling"), `yard name missing: ${title}`);
  assert.ok(title.includes("Bright Wire"), `the grade the caller asked about must survive: ${title}`);
  assert.ok(!/SE0|wa\.me|true/.test(title), `codes and contacts must not fill the title: ${title}`);
});

test("a price the yard hasn't touched in weeks is quoted with its age", () => {
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
  const rows = [
    { yard_name: "Fresh Yard", grade: "Bright Wire", price_per_kg: "£8.20 – £8.70", updated_at: iso(0) },
    { yard_name: "Sleepy Yard", grade: "Bright Wire", price_per_kg: "£6.00 – £6.50", updated_at: iso(24) },
  ];
  const meta = inferColumnMeta(rows);
  assert.equal(meta.find((c) => c.name === "updated_at").dateish, true);
  const source = { last_sync_at: new Date().toISOString(), schedule_minutes: 60, column_meta_json: JSON.stringify(meta) };
  const speak = (row) => buildToolResponse({
    source,
    structured: { resultCount: 1, items: [rowToItem(row, meta)], appliedFilters: {}, relaxations: [], alternatives: [] },
    args: {}, tookMs: 1,
  }).speech_hint;
  assert.ok(!/old|weeks ago/.test(speak(rows[0])), `today's price needs no caveat: ${speak(rows[0])}`);
  assert.match(speak(rows[1]), /weeks ago/, `a month-old price must not be read as today's rate: ${speak(rows[1])}`);
});

test("guidance forbids distance when none was calculated (no invented miles)", () => {
  const { db, source } = seed();
  // No location in the query -> no geo -> guidance must suppress distance.
  const noLoc = buildToolResponse({ source, structured: searchStructured(db, source, { query: "bright wire in london" }), args: {}, tookMs: 1 });
  assert.match(noLoc.guidance, /Do NOT state any distance/i, `guidance must forbid distance: ${noLoc.guidance}`);
  assert.ok(!noLoc.items.some((i) => "distance_miles" in i), "no distance field when none was computed");
});

test("area + grade filtering still narrows the marketplace", () => {
  const { db, source } = seed();
  const r = searchStructured(db, source, { query: "bright wire in manchester" });
  assert.equal(r.resultCount, 1);
  assert.equal(r.items[0].structured.yard_name, "Peak Copper Prices");
});

test("the stale-price caveat survives the salient-field trim (updated_at not dropped)", () => {
  const iso = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  const rows = [
    // 9+ columns incl. lat/lng, with updated_at last - the exact shape that
    // used to push updated_at past the 8-field trim and lose the age note.
    { yard_name: "Fresh Yard", area: "London", postcode: "N1 1AA", latitude: 51.5, longitude: -0.1, grade: "Bright Wire", price_per_kg: "£8.20 – £8.70", whatsapp: "wa.me/1", updated_at: iso(0) },
    { yard_name: "Sleepy Yard", area: "London", postcode: "N2 2BB", latitude: 51.6, longitude: -0.2, grade: "Bright Wire", price_per_kg: "£6.00 – £6.50", whatsapp: "wa.me/2", updated_at: iso(24) },
  ];
  const meta = inferColumnMeta(rows);
  const source = { last_sync_at: new Date().toISOString(), schedule_minutes: 60, column_meta_json: JSON.stringify(meta) };
  const speak = (row) => buildToolResponse({
    source, structured: { resultCount: 1, items: [rowToItem(row, meta)], appliedFilters: {}, relaxations: [], alternatives: [] },
    args: {}, tookMs: 1,
  });
  const stale = speak(rows[1]);
  assert.match(stale.speech_hint, /weeks ago/, `age caveat must survive the trim: ${stale.speech_hint}`);
  // And the coordinates must not leak into the shown card.
  assert.ok(!("latitude" in stale.items[0]) && !("longitude" in stale.items[0]), "coordinates are internal, not shown");
  assert.ok("updated_at" in stale.items[0], "the date that drives the caveat stays on the item");
});
