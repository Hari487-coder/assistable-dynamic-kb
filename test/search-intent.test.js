import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { deriveIntent } from "../src/search/intent.js";
import { searchStructured } from "../src/search/structured.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", mileage: "31000", vin: "V1" },
  { make: "Toyota", model: "Tacoma", year: "2021", price: "$26,900", mileage: "44000", vin: "V2" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", mileage: "12000", vin: "V3" },
  { make: "Toyota", model: "Corolla", year: "2020", price: "$17,500", mileage: "52000", vin: "V4" },
  { make: "Toyota", model: "Camry", year: "2022", price: "$24,300", mileage: "28000", vin: "V5" },
  { make: "Toyota", model: "RAV4", year: "2023", price: "$31,900", mileage: "9000", vin: "V6" },
  { make: "Toyota", model: "Highlander", year: "2021", price: "$33,400", mileage: "37000", vin: "V7" },
];

let db, source, columns;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  columns = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(columns), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const item = rowToItem(row, columns);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("deriveIntent parses price bounds, mileage bounds, year, and sorts", () => {
  const i1 = deriveIntent("anything under $25k", columns);
  assert.deepEqual(i1.filters.map(({ col, op, value }) => ({ col, op, value })), [{ col: "price", op: "max", value: 25000 }]);
  const i2 = deriveIntent("under 40000 miles please", columns);
  assert.equal(i2.filters[0].col, "mileage");
  assert.equal(i2.filters[0].value, 40000);
  const i3 = deriveIntent("the 2023 one", columns);
  assert.deepEqual(i3.filters.map(({ col, op, value }) => ({ col, op, value })), [{ col: "year", op: "eq", value: 2023 }]);
  assert.deepEqual(deriveIntent("whats your cheapest suv", columns).sort, { col: "price", dir: "asc" });
  assert.deepEqual(deriveIntent("newest toyota you have", columns).sort, { col: "year", dir: "desc" });
});

test("safety net: 'under 25k' applies price filter when the LLM passed no typed filters", () => {
  const r = searchStructured(db, source, { query: "any toyota under 25k" });
  assert.ok(r.resultCount >= 1);
  const returned = [...r.items];
  assert.ok(returned.every((i) => i.structured.price <= 25000), "every result respects the spoken bound");
  assert.ok(r.relaxations.some((n) => /under 25k|under \$25k/i.test(n)));
});

test("explicit LLM filter wins over query-derived bound", () => {
  const r = searchStructured(db, source, { query: "under 20k", filters: { price_max: 30000 } });
  assert.equal(r.appliedFilters.price_max, 30000, "typed arg must not be overridden");
});

test("sort intent: cheapest returns lowest price first", () => {
  const r = searchStructured(db, source, { query: "whats your cheapest car", filters: {} });
  assert.equal(r.items[0].structured.price, 17500);
  assert.ok(r.relaxations.some((n) => /sorted by price low to high/.test(n)));
});

test("sort skips rows missing the sorted value (NULLs sort first in SQLite)", () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => ({ material: `Copper Grade ${String.fromCharCode(65 + i)}`, price: `£${(i + 3).toFixed(2)}` })),
    { material: "Mixed Load", price: "call for price" }, // -> null, but 90% still parse: column stays numeric
  ];
  const meta = inferColumnMeta(rows);
  const db2 = openDb(":memory:");
  db2.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db2.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
               VALUES ('s1','u1','csv','prices','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db2.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of rows) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  const src = db2.prepare("SELECT * FROM sources WHERE id='s1'").get();
  const r = searchStructured(db2, src, { query: "whats your cheapest material", filters: {} });
  assert.equal(r.items[0].structured.price, 3, "cheapest must be a real price, not a missing one");
  assert.ok(r.items.every((i) => i.structured.price !== null), "unpriced rows never appear in a price sort");
});

test("sort intent: newest returns latest year first", () => {
  const r = searchStructured(db, source, { query: "newest thing on the lot" });
  assert.equal(r.items[0].structured.year, 2023);
});

test("result_count is the TRUE total while items cap at 5", () => {
  const r = searchStructured(db, source, { query: "", filters: { make: "Toyota" } });
  assert.equal(r.resultCount, 7, "must report all matches, not the page size");
  assert.equal(r.items.length, 5, "payload stays voice-sized");
});
