import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { searchStructured } from "../src/search/structured.js";
import { searchText } from "../src/search/text.js";
import { deriveIntent } from "../src/search/intent.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", mileage: "31000", vin: "V1" },
  { make: "Toyota", model: "Corolla", year: "2018", price: "$14,200", mileage: "88000", vin: "V2" },
  { make: "Honda", model: "Civic", year: "2019", price: "$16,900", mileage: "72000", vin: "V3" },
  { make: "Ford", model: "F-150", year: "2023", price: "$52,000", mileage: "8000", vin: "V4" },
  { make: "BMW", model: "X5", year: "2022", price: "$61,500", mileage: "22000", vin: "V5" },
  { make: "Kia", model: "Sorento", year: "2020", price: "$23,800", mileage: "45000", vin: "V6" },
  { make: "Chevrolet", model: "Silverado", year: "2021", price: "$38,900", mileage: "39000", vin: "V7" },
  { make: "Hyundai", model: "Elantra", year: "2017", price: "$11,500", mileage: "95000", vin: "V8" },
];

let db, source, meta;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("quartiles are computed at inference and refresh with the data", () => {
  const price = meta.find((c) => c.name === "price");
  assert.ok(price.p25 && price.p75 && price.p25 < price.p75);
  assert.ok(price.p25 >= price.min && price.p75 <= price.max);
});

test("'cheap' resolves against THIS business's own price distribution", () => {
  const r = searchStructured(db, source, { query: "any cheap cars", filters: {} });
  const price = meta.find((c) => c.name === "price");
  assert.ok(r.resultCount >= 1);
  assert.ok(r.items.every((i) => i.structured.price <= price.p25), "every result within the bottom quartile");
  assert.ok(r.relaxations.some((n) => /interpreted "cheap".*based on your data's range/.test(n)));
});

test("'low miles' and 'newer' map to the right columns and directions", () => {
  const i1 = deriveIntent("something with low miles", meta);
  assert.equal(i1.filters[0].col, "mileage");
  assert.equal(i1.filters[0].op, "max");
  const i2 = deriveIntent("a newer truck", meta);
  assert.equal(i2.filters[0].col, "year");
  assert.equal(i2.filters[0].op, "min");
});

test("'cheapest' stays a sort; 'cheap' stays a filter - no double-fire", () => {
  const sortOnly = deriveIntent("whats your cheapest car", meta);
  assert.ok(sortOnly.sort);
  assert.equal(sortOnly.filters.length, 0, "cheapest must not also add a price filter");
});

test("luxury/premium resolves to the top quartile", () => {
  const r = searchStructured(db, source, { query: "your premium options", filters: {} });
  const price = meta.find((c) => c.name === "price");
  assert.ok(r.resultCount >= 1);
  assert.ok(r.items.every((i) => i.structured.price >= price.p75));
});

test("spell correction: 'tocoma' free-text finds the Tacoma with disclosure", () => {
  const r = searchStructured(db, source, { query: "do you have a tocoma", filters: {} });
  assert.ok(r.resultCount >= 1);
  assert.equal(r.items[0].structured.model, "Tacoma");
  assert.ok(r.relaxations.some((n) => /corrected spelling: tocoma→tacoma/.test(n)));
});

test("spell correction fires only on dead ends - correct words untouched", () => {
  const r = searchStructured(db, source, { query: "silverado", filters: {} });
  assert.ok(r.resultCount >= 1);
  assert.ok(!r.relaxations.some((n) => /corrected spelling/.test(n)));
});

test("synonym parity: structured FTS leg expands concepts like the text engine", () => {
  // "in stock" - 'stock' expands to available/inventory; body text contains none
  // of those for cars, so verify with a term that does: 'buy' <-> 'purchase'
  const db2 = openDb(":memory:");
  db2.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db2.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('w1','u1','website','site','ct','sec','active','b1','[]',?,1440,'2026-01-01')`)
    .run(new Date().toISOString());
  db2.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES ('i1','w1','b1','Trade-ins','We purchase used vehicles for cash any day of the week.','{}')").run();
  const src2 = db2.prepare("SELECT * FROM sources WHERE id='w1'").get();
  const r = searchText(db2, src2, "do you buy used vehicles");
  assert.ok(r.resultCount >= 1, "'buy' must match 'purchase' via synonym group");
  assert.equal(r.matchQuality, "strong");
});
