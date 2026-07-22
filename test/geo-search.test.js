import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { openDb } from "../src/db.js";
import { haversineMiles, findGeoCols, geocodeUK, parseGeoFromQuery } from "../src/search/geo.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { searchStructured } from "../src/search/structured.js";
import { buildToolDefinition } from "../src/assistable/tool-def.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";

// Real coordinates: the distance maths must survive contact with a map.
const CROYDON = { lat: 51.3762, lng: -0.0982 };
const YARDS = [
  ["Sullivans Metal Recycling", "London", 51.3980, -0.0680, "Bright Wire", "£8.20 – £8.70"],   // ~2 mi from Croydon
  ["EMR Mitcham", "London", 51.3920, -0.1500, "Bright Wire", "£7.79 – £7.80"],                 // ~2.5 mi
  ["MetalCom Scrap Metal", "London", 51.5890, -0.2540, "Bright Wire", "£8.00 – £8.95"],        // ~16 mi
  ["Peak Copper Prices", "Manchester", 53.4808, -2.2426, "Bright Wire", "£8.10 – £8.60"],      // ~160 mi
];
const ROWS = YARDS.map(([yard_name, area, latitude, longitude, grade, price_per_kg]) =>
  ({ yard_name, area, latitude, longitude, grade, price_per_kg }));

test("resolveGeoArgs: the shared pre-step the webhook and Try-it both use", async () => {
  const { resolveGeoArgs } = await import("../src/search/geo.js");
  const meta = inferColumnMeta(ROWS);
  const geocode = async (p) => (/croydon/i.test(p) ? { lat: 51.3762, lng: -0.0982, label: "Croydon" } : null);
  // Spoken location resolves and is stripped from the query.
  const a = await resolveGeoArgs(meta, { query: "bright wire within 10 miles of croydon" }, geocode);
  assert.equal(a._geo.label, "Croydon");
  assert.equal(a._geo.radiusMiles, 10);
  assert.ok(!/croydon/i.test(a.query), "the matched location phrase is stripped from the FTS query");
  // Unresolvable place flags _geoFail, never throws.
  const b = await resolveGeoArgs(meta, { query: "bright wire near Atlantis" }, geocode);
  assert.equal(b._geoFail, "Atlantis");
  // No coordinates in the data -> untouched.
  const noGeo = inferColumnMeta([{ grade: "Bright Wire", price_per_kg: "£8" }]);
  const c = await resolveGeoArgs(noGeo, { query: "bright wire near croydon" }, geocode);
  assert.equal(c._geo, undefined);
});

test("haversine: London to Manchester is ~163 miles", () => {
  const d = haversineMiles(51.5074, -0.1278, 53.4808, -2.2426);
  assert.ok(Math.abs(d - 163) < 5, `got ${d}`);
});

test("geo columns are found by name AND sanity-checked by range", () => {
  const meta = inferColumnMeta(ROWS);
  assert.deepEqual(findGeoCols(meta), { lat: "latitude", lng: "longitude" });
  // A "latitude" column full of prices must not qualify.
  const fake = [{ name: "latitude", kind: "numeric", min: 100, max: 9000 }, { name: "longitude", kind: "numeric", min: -1, max: 1 }];
  assert.equal(findGeoCols(fake), null);
  assert.equal(findGeoCols(meta.filter((c) => c.name !== "longitude")), null, "one column alone is not a location");
});

test("geocodeUK: postcode, outcode and place routes; cached after first hit", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ result: url.includes("/places") ? [{ latitude: 51.5, longitude: -0.1, name_1: "London" }] : { latitude: 51.376, longitude: -0.098, postcode: "CR4 4HX" } }) };
  };
  const pc = await geocodeUK("CR4 4HX", fetchImpl);
  assert.ok(calls[0].includes("/postcodes/"), "full postcode uses the postcode route");
  assert.equal(pc.lat, 51.376);
  await geocodeUK("cr4 4hx", fetchImpl);
  assert.equal(calls.length, 1, "second lookup of the same postcode is served from cache");
  await geocodeUK("SW19", fetchImpl);
  assert.ok(calls[1].includes("/outcodes/"), "partial postcode uses the outcode route");
  const place = await geocodeUK("Croydon Town", fetchImpl);
  assert.ok(calls[2].includes("/places?q="), "place names use the places route");
  assert.equal(place.label, "London");
  // Failures cache as null and never throw.
  assert.equal(await geocodeUK("Nowhereville", async () => { throw new Error("down"); }), null);
});

test("spoken location intent parses; 'near me' never geocodes", () => {
  assert.deepEqual(parseGeoFromQuery("bright wire within 10 miles of Croydon"),
    { near: "Croydon", radiusMiles: 10, matched: "within 10 miles of Croydon" });
  assert.equal(parseGeoFromQuery("copper prices near CR4 4HX").near, "CR4 4HX");
  assert.equal(parseGeoFromQuery("yards around Wimbledon").near, "Wimbledon");
  assert.equal(parseGeoFromQuery("who pays the most near me"), null);
  assert.equal(parseGeoFromQuery("what are your prices"), null);
});

function seed() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')").run();
  const meta = inferColumnMeta(ROWS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','database','Yard prices','ct','geo-secret','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of ROWS) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  return { db, meta, source: db.prepare("SELECT * FROM sources WHERE id='s1'").get() };
}

test("postcode is hidden with no location, kept once a distance is computed", async () => {
  const { db, source } = seed();
  const { buildToolResponse } = await import("../src/search/respond.js");
  // No location -> no distance -> postcode stripped (kills invented "8 miles").
  const noLoc = buildToolResponse({ source, structured: searchStructured(db, source, { query: "bright wire in london" }), args: {}, tookMs: 1 });
  assert.ok(noLoc.items.every((i) => !("postcode" in i)), "postcode must not tempt an invented distance");
  // Real location -> geo runs -> distance present -> postcode kept for directions.
  const located = buildToolResponse({ source, structured: searchStructured(db, source, { query: "bright wire", _geo: { ...CROYDON, radiusMiles: 25, label: "Croydon" } }), args: {}, tookMs: 1 });
  assert.ok(located.items.some((i) => "distance_miles" in i), "located query has distances");
});

test("radius search: in-range only, nearest first, distance attached", () => {
  const { db, source } = seed();
  const r = searchStructured(db, source, { query: "bright wire", _geo: { ...CROYDON, radiusMiles: 25, label: "Croydon" } });
  assert.equal(r.resultCount, 3, "Manchester is 160 miles out");
  assert.equal(r.items[0].structured.yard_name, "Sullivans Metal Recycling", "nearest yard leads");
  assert.ok(r.items[0].structured.distance_miles < r.items[1].structured.distance_miles);
  assert.ok(r.items.every((i) => i.structured.distance_miles <= 25));
  assert.ok(r.relaxations.some((n) => /within 25 miles of Croydon/.test(n)));
  assert.equal(r.appliedFilters.near, "Croydon");
});

test("'who pays the most' within a radius sorts by price, not distance", () => {
  const { db, source } = seed();
  const r = searchStructured(db, source, { query: "who pays the most for bright wire", _geo: { ...CROYDON, radiusMiles: 25, label: "Croydon" } });
  assert.equal(r.items[0].structured.yard_name, "MetalCom Scrap Metal",
    "MetalCom's 8.00-8.95 band has the highest in-range midpoint (8.475), 16 miles out - price outranks distance when the caller asked who pays most: "
    + JSON.stringify(r.items.map((i) => [i.structured.yard_name, i.structured.price_per_kg])));
  const prices = r.items.map((i) => i.structured.price_per_kg);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a), "sorted high to low");
});

test("nothing in range -> nearest options disclosed as alternatives", () => {
  const { db, source } = seed();
  // Leeds: ~36 miles from the Manchester yard, ~160 from the London ones.
  const r = searchStructured(db, source, { query: "bright wire", _geo: { lat: 53.8008, lng: -1.5491, radiusMiles: 5, label: "LS1" } });
  assert.equal(r.resultCount, 0);
  assert.equal(r.alternatives[0].structured.yard_name, "Peak Copper Prices", "the Manchester yard is the nearest");
  assert.ok(r.relaxations.some((n) => /nothing within 5 miles/.test(n)));
});

test("unresolvable location degrades to a normal search with a note", () => {
  const { db, source } = seed();
  const r = searchStructured(db, source, { query: "bright wire", _geoFail: "Atlantis" });
  assert.ok(r.resultCount >= 1, "search still answers");
  assert.ok(r.relaxations.some((n) => /couldn't locate "Atlantis"/.test(n)));
});

test("tool schema advertises near+radius only when the data has coordinates", () => {
  const { meta } = seed();
  const withGeo = buildToolDefinition({ id: "s1", name: "Yard prices" }, meta, { baseUrl: "https://kb.test", secret: "s" });
  assert.ok(withGeo.parameters.properties.near, "near param advertised");
  assert.ok(withGeo.parameters.properties.radius_miles, "radius param advertised");
  const noGeo = buildToolDefinition({ id: "s1", name: "Prices" }, meta.filter((c) => !/latitude|longitude/.test(c.name)), { baseUrl: "https://kb.test", secret: "s" });
  assert.ok(!noGeo.parameters.properties.near, "no coordinates, no distance params");
});

test("end-to-end: the tool endpoint geocodes 'near' and answers with distances", async () => {
  const { db } = seed();
  const geocode = async (place) => (/croydon|cr0/i.test(place) ? { ...CROYDON, label: "Croydon" } : null);
  const app = express();
  app.use(express.json());
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} }, config: null, connectors: null, geocode }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (payload) => fetch(`${base}/api/tools/s1/search`, {
    method: "POST", headers: { "content-type": "application/json", "x-bridge-secret": "geo-secret" },
    body: JSON.stringify({ args: payload, meta_data: {}, metadata: {}, call: { call_id: "cc-geo" } }),
  }).then((r) => r.json());

  // Typed args, as the LLM should send them. distance_miles is shown to the
  // LLM as a spelled-out string ("2 miles"), so parse the number back to check.
  const milesOf = (i) => Number(String(i.distance_miles ?? "").replace(/[^\d.]/g, ""));
  let out = await call({ query: "best bright wire price", near: "Croydon", radius_miles: 10 });
  assert.equal(out.ok, true);
  assert.match(out.speech_hint, /miles away/, `distance must be spoken: ${out.speech_hint}`);
  assert.ok(out.items.every((i) => milesOf(i) <= 10));

  // Location inside the spoken query, no typed args.
  out = await call({ query: "bright wire within 5 miles of Croydon" });
  assert.equal(out.result_count, 2, "only the two ~2-mile yards are within 5 miles");

  // Follow-up carries the location through conversation memory.
  out = await call({ query: "and what about the highest paying one" });
  assert.ok(out.ok, true);
  assert.ok((out.items ?? []).every((i) => i.distance_miles == null || milesOf(i) <= 5), JSON.stringify(out.items));

  srv.close();
});
