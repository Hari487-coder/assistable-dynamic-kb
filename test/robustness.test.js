import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { searchStructured } from "../src/search/structured.js";
import { buildToolResponse } from "../src/search/respond.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "V1" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", vin: "V2" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", vin: "V3" },
];

let db, source, base, srv;
before(async () => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  const app = express();
  app.use(express.json());
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} } }));
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});

test("malformed LLM args never break search: arrays, objects, NaN strings, $ values", () => {
  const r = searchStructured(db, source, {
    query: "toyota",
    filters: { make: ["Toyota", "Honda"], model: { nested: "junk" }, price_max: "$30k", year_min: "not-a-number" },
  });
  assert.ok(r.resultCount >= 1, "array->first, object->skip, '$30k'->30000, junk->skip");
  assert.equal(r.appliedFilters.make, "Toyota");
  assert.equal(r.appliedFilters.price_max, 30000);
  assert.ok(!("year_min" in r.appliedFilters));
});

test("impossible min>max range is dropped with a disclosed note", () => {
  const r = searchStructured(db, source, { query: "", filters: { make: "Toyota", price_min: 50000, price_max: 20000 } });
  assert.ok(r.resultCount >= 1, "must not silently return nothing");
  assert.ok(r.relaxations.some((n) => /impossible range on price/.test(n)));
});

test("browse mode: empty call returns catalog size + what can be asked", () => {
  const r = searchStructured(db, source, { query: "", filters: {} });
  assert.equal(r.browse, true);
  assert.equal(r.resultCount, 3);
  const out = buildToolResponse({ source, structured: r, args: {}, tookMs: 1 });
  assert.match(out.speech_hint, /We have 3 options/);
  assert.match(out.speech_hint, /make/);
  assert.match(out.guidance, /clarifying question/);
});

test("corrupt column metadata degrades to keyword search, not a dead tool", () => {
  const broken = { ...source, column_meta_json: "{not json!!" };
  const r = searchStructured(db, broken, { query: "tacoma" });
  assert.ok(r.resultCount >= 1, "keyword leg must still answer");
});

test("oversized query strings are clamped, not fatal", () => {
  const r = searchStructured(db, source, { query: "tacoma " + "x".repeat(10_000) });
  assert.ok(r.resultCount >= 1 || r.alternatives.length >= 1);
});

test("retry storms are absorbed: identical call returns cached result, sync swap invalidates", async () => {
  const call = () => fetch(`${base}/api/tools/s1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": "sec" },
    body: JSON.stringify({ args: { query: "civic" }, meta_data: {}, metadata: {}, call: {} }),
  }).then((x) => x.json());
  const first = await call();
  assert.equal(first.cached, undefined);
  const second = await call();
  assert.equal(second.cached, true, "identical retry must be served from cache");
  assert.equal(second.result_count, first.result_count);
  // a sync swap (new batch id) must invalidate immediately
  db.prepare("UPDATE sources SET active_batch_id='b2' WHERE id='s1'").run();
  db.prepare(`INSERT INTO items (id,source_id,batch_id,title,body,structured_json)
              VALUES ('n1','s1','b2','2021 Honda Civic','2021 Honda Civic 18900','{"make":"Honda","model":"Civic","year":2021,"price":18900}')`).run();
  const third = await call();
  assert.equal(third.cached, undefined, "new batch means fresh answer");
  assert.equal(third.items[0].price, 18900, "must reflect the newly swapped data");
  srv.close();
});
