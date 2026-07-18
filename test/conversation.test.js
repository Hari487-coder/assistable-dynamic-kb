import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { searchText } from "../src/search/text.js";
import { buildToolResponse } from "../src/search/respond.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "V1", color: "Silver" },
  { make: "Toyota", model: "Tacoma", year: "2021", price: "$26,900", vin: "V2", color: "Red" },
  { make: "Toyota", model: "Tundra", year: "2021", price: "$39,000", vin: "V3", color: "Black" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", vin: "V4", color: "White" },
];

let base, db, srv;
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
  // website source for text-search tests
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('w1','u1','website','site','ct','wsec','active','wb1','[]',?,1440,'2026-01-01')`)
    .run(new Date().toISOString());
  ins.run(crypto.randomUUID(), "w1", "wb1", "Screen Repair", "Screen Repair We repair cracked phone screens same day. Repair cost starts at forty five dollars.", "{}");
  ins.run(crypto.randomUUID(), "w1", "wb1", "Store Hours", "Store Hours Open Monday to Saturday nine to six.", "{}");

  const app = express();
  app.use(express.json());
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} } }));
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = (sourceId, secret, args, callId) =>
  fetch(`${base}/api/tools/${sourceId}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": secret, ...(callId ? { call_control_id: callId } : {}) },
    body: JSON.stringify({ args, meta_data: {}, metadata: {}, call: {} }),
  }).then((r) => r.json());

test("synonyms: caller says 'fix', site says 'repair' - still found, strong match", () => {
  const source = db.prepare("SELECT * FROM sources WHERE id='w1'").get();
  const r = searchText(db, source, "how much to fix my screen");
  assert.ok(r.resultCount >= 1);
  assert.equal(r.matchQuality, "strong", "fix->repair synonym must satisfy the AND match");
  assert.match(r.items[0].snippet, /repair/i);
});

test("weak text matches are labeled low-confidence and hedged", () => {
  const source = db.prepare("SELECT * FROM sources WHERE id='w1'").get();
  const r = searchText(db, source, "screen warranty length");
  assert.equal(r.matchQuality, "weak", "partial match must not masquerade as an answer");
  const out = buildToolResponse({ source, textResult: r, args: {}, tookMs: 1 });
  assert.equal(out.confidence, "low");
  assert.equal(out.answerable, false);
  assert.match(out.speech_hint, /might be related/i);
});

test("voice hint lists the top two options on multi-match", async () => {
  const out = await call("s1", "sec", { query: "", filters: { model: "Tacoma" } }, "call-a");
  assert.equal(out.result_count, 2);
  assert.match(out.speech_hint, /Best fit: a 2022 Toyota Tacoma at \$28,500; also a 2021 Toyota Tacoma at \$26,900\./);
});

test("conversation memory: 'what about the 2021?' inherits the Tacoma context", async () => {
  await call("s1", "sec", { query: "tacomas please", filters: { model: "Tacoma" } }, "call-b");
  const out = await call("s1", "sec", { query: "what about the 2021?" }, "call-b");
  assert.equal(out.result_count, 1, "must be the 2021 TACOMA, not every 2021 vehicle");
  assert.equal(out.items[0].vin, "V2");
  assert.ok(out.relaxations.some((n) => /carried from earlier in this conversation: model=Tacoma/.test(n)));
});

test("non-anaphoric queries do NOT inherit context", async () => {
  await call("s1", "sec", { query: "", filters: { model: "Tacoma" } }, "call-c");
  const out = await call("s1", "sec", { query: "honda civic" }, "call-c");
  assert.equal(out.result_count, 1);
  assert.equal(out.items[0].vin, "V4", "a fresh subject must escape the old filters");
});

test("context never leaks across different calls", async () => {
  await call("s1", "sec", { query: "", filters: { model: "Tacoma" } }, "call-d");
  const out = await call("s1", "sec", { query: "what about the 2021?" }, "call-e");
  assert.ok(out.result_count > 1 || out.items?.every?.((i) => i.year === 2021),
    "call-e must not inherit call-d's Tacoma filter");
  assert.ok(!(out.relaxations || []).some((n) => /carried from earlier/.test(n)));
  srv.close();
});
