import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import crypto from "node:crypto";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "VIN001" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", vin: "VIN004" },
];
let base, db, srv;

before(async () => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','topsecret','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} } }));
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("valid envelope call returns results", async () => {
  const res = await call("/api/tools/s1/search",
    { args: { query: "tacoma", make: "Toyota", price_max: 30000 }, meta_data: { tool_id: "t" }, metadata: {}, call: { call_id: "c1" } },
    { "x-bridge-secret": "topsecret" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
  assert.ok(out.speech_hint);
  const logged = db.prepare("SELECT * FROM tool_calls WHERE source_id='s1'").all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].ok, 1);
});

test("raw args body (direct mode) also works", async () => {
  const res = await call("/api/tools/s1/search", { query: "civic" }, { "x-bridge-secret": "topsecret" });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
});

test("bad secret -> 404 empty", async () => {
  const res = await call("/api/tools/s1/search", { query: "x" }, { "x-bridge-secret": "wrong" });
  assert.equal(res.status, 404);
  assert.equal((await res.text()).length, 0);
});

test("missing secret -> 404; unknown source -> 404", async () => {
  assert.equal((await call("/api/tools/s1/search", {})).status, 404);
  assert.equal((await call("/api/tools/nope/search", {}, { "x-bridge-secret": "topsecret" })).status, 404);
});

test("never-synced source -> 200 with speakable error", async () => {
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,column_meta_json,schedule_minutes,created_at)
              VALUES ('s2','u1','csv','new','ct','sec2','never_synced','[]',1440,'2026-01-01')`).run();
  const res = await call("/api/tools/s2/search", { query: "x" }, { "x-bridge-secret": "sec2" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.equal(out.error, "not_synced");
  assert.ok(out.speech_hint);
  srv.close();
});
