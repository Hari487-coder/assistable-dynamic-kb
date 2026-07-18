import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { resolveCategorical, editDistance } from "../src/search/normalize.js";
import { searchStructured } from "../src/search/structured.js";
import { searchText } from "../src/search/text.js";
import { buildToolResponse } from "../src/search/respond.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import crypto from "node:crypto";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", mileage: "31000", vin: "VIN001", color: "Silver", status: "available" },
  { make: "Toyota", model: "Tacoma", year: "2021", price: "$26,900", mileage: "44000", vin: "VIN002", color: "Red", status: "available" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", mileage: "12000", vin: "VIN003", color: "Black", status: "available" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", mileage: "38000", vin: "VIN004", color: "White", status: "available" },
  { make: "Chevrolet", model: "Silverado", year: "2022", price: "$36,750", mileage: "25500", vin: "VIN005", color: "Blue", status: "pending" },
];

let db, source;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inventory','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("Tacoma under 30k: exact structured hit (year derived from query)", () => {
  const r = searchStructured(db, source, { query: "2022 tacoma", filters: { make: "Toyota", model: "Tacoma", price_max: 30000 } });
  assert.equal(r.resultCount, 1, "the spoken year 2022 must narrow to the 2022 truck");
  assert.equal(r.items[0].structured.vin, "VIN001");
  assert.ok(r.relaxations.some((n) => /year 2022/.test(n)), "derivation must be visible in relaxations");
});

test("alias: chevy resolves to Chevrolet", () => {
  const r = searchStructured(db, source, { query: "", filters: { make: "chevy" } });
  assert.equal(r.resultCount, 1);
  assert.equal(r.items[0].structured.make, "Chevrolet");
});

test("fuzzy: tocoma within edit distance 2", () => {
  assert.equal(editDistance("tocoma", "tacoma"), 1);
  const r = searchStructured(db, source, { query: "", filters: { model: "tocoma" } });
  assert.equal(r.resultCount, 2);
});

test("zero results returns alternatives, never bare empty", () => {
  const r = searchStructured(db, source, { query: "tacoma", filters: { model: "Tacoma", price_max: 20000 } });
  assert.equal(r.resultCount, 0);
  assert.ok(r.alternatives.length >= 1, "must offer closest alternatives");
  assert.ok(r.relaxations.length >= 1);
});

test("ecommerce variant: flat top-level args accepted (no filters object)", () => {
  const r = searchStructured(db, source, { query: "silverado", make: "Chevrolet" });
  assert.equal(r.resultCount, 1);
});

test("text search with bm25 + snippet", () => {
  const r = searchText(db, source, "tundra black");
  assert.ok(r.resultCount >= 1);
  assert.match(r.items[0].snippet, /Tundra/i);
});

test("response shape: compact, speakable, fresh", () => {
  const structured = searchStructured(db, source, { query: "tacoma", filters: { model: "Tacoma", price_max: 30000 } });
  const out = buildToolResponse({ source, structured, args: { query: "tacoma" }, tookMs: 42 });
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 2);
  assert.equal(out.data_freshness, "fresh");
  assert.ok(out.speech_hint.length > 20 && out.speech_hint.length < 400);
  assert.ok(JSON.stringify(out).length <= 1600);
  assert.ok(out.items[0].price);
});

test("stale source is flagged in response", () => {
  const staleSource = { ...source, last_sync_at: "2026-01-01T00:00:00Z" };
  const structured = searchStructured(db, staleSource, { query: "civic", filters: {} });
  const out = buildToolResponse({ source: staleSource, structured, args: {}, tookMs: 5 });
  assert.equal(out.data_freshness, "stale");
});
