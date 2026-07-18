import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { classifyOutcome, callFlags, qualitySummary } from "../src/analytics/quality.js";
import { qualitySection } from "../src/views/pages.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

test("classifyOutcome buckets every response shape", () => {
  assert.equal(classifyOutcome({ ok: true, result_count: 2 }), "answered");
  assert.equal(classifyOutcome({ ok: true, result_count: 1, answerable: false }), "weak");
  assert.equal(classifyOutcome({ ok: true, result_count: 0, close_alternatives: [{}] }), "alternatives");
  assert.equal(classifyOutcome({ ok: true, result_count: 0 }), "no_match");
  assert.equal(classifyOutcome({ ok: true, browse: true, result_count: 40 }), "browse");
  assert.equal(classifyOutcome({ ok: false, error: "not_synced" }), "not_synced");
  assert.equal(classifyOutcome({ ok: false, error: "temporarily_unavailable" }), "error");
});

test("callFlags detects what the engine did", () => {
  const flags = callFlags({
    ok: true, cached: true, data_freshness: "stale",
    relaxations: ['corrected spelling: tocoma→tacoma', 'interpreted "cheap" as price up to 16900 (based on your data\'s range)', "carried from earlier in this conversation: model=Tacoma"],
  });
  for (const f of ["spell", "qualitative", "context", "cached", "stale_data"]) {
    assert.ok(flags.split(",").includes(f), `missing ${f}`);
  }
  assert.equal(callFlags({ ok: true, relaxations: [] }), "");
});

test("qualitySummary aggregates rates, latency percentiles and dead ends", () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO tool_calls (source_id,ts,args_json,result_count,relaxations,took_ms,ok,outcome,flags) VALUES (?,?,?,?,?,?,?,?,?)");
  const now = new Date().toISOString();
  for (let i = 0; i < 7; i++) ins.run("s1", now, '{"query":"tacoma"}', 2, "[]", 10 + i, 1, "answered", i < 2 ? "spell" : "");
  ins.run("s1", now, '{"query":"lamborghini"}', 0, "[]", 12, 1, "no_match", "");
  ins.run("s1", now, '{"query":"lamborghini"}', 0, "[]", 12, 1, "no_match", "");
  ins.run("s1", now, '{"query":"cheap truck"}', 0, "[]", 90, 1, "alternatives", "qualitative");
  // other source + an old row must be excluded
  ins.run("s2", now, '{"query":"x"}', 0, "[]", 5, 1, "no_match", "");
  ins.run("s1", "2020-01-01T00:00:00Z", '{"query":"ancient"}', 0, "[]", 5, 1, "no_match", "");

  const q = qualitySummary(db, { sourceId: "s1", days: 7 });
  assert.equal(q.total, 10, "scoped to this source and window");
  assert.equal(q.answered, 7);
  assert.equal(q.alternatives, 1);
  assert.equal(q.noMatch, 2);
  assert.equal(q.helpedPct, 80, "answered + alternatives");
  assert.equal(q.deadEndPct, 20, "the semantic-fallback decision number");
  assert.equal(q.spell, 2);
  assert.equal(q.qualitative, 1);
  assert.ok(q.p95 >= q.p50);
  assert.equal(q.unanswered[0].query, "lamborghini");
  assert.equal(q.unanswered[0].n, 2, "repeat dead ends rank first");

  const instance = qualitySummary(db, { days: 7 });
  assert.equal(instance.total, 11, "instance-wide includes every source");
});

test("qualitySection renders plain language, and an honest empty state", () => {
  const empty = qualitySection({ total: 0, days: 7, unanswered: [] });
  assert.match(empty, /No questions yet/);
  const html = qualitySection({
    days: 7, total: 10, answered: 7, alternatives: 1, noMatch: 2, weak: 0, browse: 0,
    helpedPct: 80, answeredPct: 70, deadEndPct: 20, p50: 12, p95: 90,
    spell: 2, qualitative: 1, context: 0, relaxed: 1, cached: 0,
    unanswered: [{ query: "lamborghini", n: 2 }],
  });
  assert.match(html, /questions asked/);
  assert.match(html, /80%/);
  assert.match(html, /got a useful answer/);
  assert.match(html, /understood vague wording like cheap or low miles 1x/);
  assert.match(html, /fixed misheard words 2x/);
  assert.match(html, /lamborghini/);
  assert.ok(!html.includes("<script"), "no injection surface in generated stats");
});

test("live tool calls record outcome + flags end to end", async () => {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const CARS = [
    { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "V1" },
    { make: "Honda", model: "Civic", year: "2021", price: "$19,900", vin: "V2" },
  ];
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  const app = express();
  app.use(express.json());
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} } }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (query) => fetch(`${base}/api/tools/s1/search`, {
    method: "POST", headers: { "content-type": "application/json", "x-bridge-secret": "sec" },
    body: JSON.stringify({ args: { query }, meta_data: {}, metadata: {}, call: {} }),
  }).then((r) => r.json());

  await call("tacoma");            // answered
  await call("tocoma");            // answered via spell correction
  const dead = await call("submarine");
  // A word that matches nothing must never be answered with arbitrary rows.
  assert.equal(dead.result_count, 0, "no fabricated matches for an unknown thing");
  assert.match(dead.speech_hint, /Nothing in our current live data matches/);

  const rows = db.prepare("SELECT outcome, flags FROM tool_calls ORDER BY id").all();
  assert.equal(rows[0].outcome, "answered");
  assert.equal(rows[1].outcome, "answered");
  assert.ok(rows[1].flags.includes("spell"), "spell correction recorded as a flag");
  assert.equal(rows[2].outcome, "no_match");

  const q = qualitySummary(db, { sourceId: "s1", days: 7 });
  assert.equal(q.total, 3);
  assert.equal(q.spell, 1);
  srv.close();
});
