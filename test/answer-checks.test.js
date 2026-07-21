import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import {
  answerFingerprint, compareAnswer, mineChecks, runAnswerChecks, checksSummary, normalizeQuery,
} from "../src/analytics/answer-checks.js";

const ROWS = [
  { material: "Bare Bright Copper", grade: "copper", price_per_kg: "£7.20" },
  { material: "Copper Tube", grade: "copper", price_per_kg: "£6.10" },
  { material: "Lead", grade: "lead", price_per_kg: "£1.60" },
];

function seed(rows = ROWS) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')").run();
  const meta = inferColumnMeta(rows);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','webtable','Scrap','ct','sec','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of rows) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  return db;
}

const logCall = (db, query, outcome = "answered") =>
  db.prepare(`INSERT INTO tool_calls (source_id,ts,args_json,result_count,took_ms,ok,outcome,flags)
              VALUES ('s1',?,?,3,20,1,?,'')`)
    .run(new Date().toISOString(), JSON.stringify({ query }), outcome);

test("normalizeQuery collapses the shapes of the same question", () => {
  assert.equal(normalizeQuery("  What   do you PAY for Copper? "), "what do you pay for copper?");
});

test("compareAnswer: a moving price is 'changed', never a failure", () => {
  const baseline = answerFingerprint({ ok: true, result_count: 1, items: [{ title: "Copper", price_per_kg: 7.2 }] });
  const today = answerFingerprint({ ok: true, result_count: 1, items: [{ title: "Copper", price_per_kg: 7.6 }] });
  const r = compareAnswer(baseline, today);
  assert.equal(r.status, "changed", "live prices move by design - that must not read as broken");
  assert.match(r.detail, /7\.2 -> 7\.6/);
});

test("compareAnswer: answering nothing after answering something is a regression", () => {
  const baseline = answerFingerprint({ ok: true, result_count: 3, items: [{ title: "Copper" }] });
  const today = answerFingerprint({ ok: true, result_count: 0, items: [] });
  const r = compareAnswer(baseline, today);
  assert.equal(r.status, "regressed");
  assert.match(r.detail, /used to return 3/i);
});

test("compareAnswer: an errored answer is a regression", () => {
  const baseline = answerFingerprint({ ok: true, result_count: 1, items: [{ title: "Copper" }] });
  assert.equal(compareAnswer(baseline, answerFingerprint({ ok: false })).status, "regressed");
});

test("mineChecks promotes real answered questions, deduped, and ignores dead ends", () => {
  const db = seed();
  logCall(db, "what do you pay for copper");
  logCall(db, "What do you pay for COPPER");   // same question, different shape
  logCall(db, "price of lead");
  logCall(db, "do you buy platinum", "no_match"); // never answered -> not a check
  const added = mineChecks(db, "s1");
  assert.equal(added, 2, "two distinct answered questions");
  const queries = db.prepare("SELECT query FROM answer_checks ORDER BY query").all().map((r) => r.query);
  assert.deepEqual(queries, ["price of lead", "what do you pay for copper"]);
});

test("checks pass against live data, then a broken sync shows up as a regression that persists", () => {
  const db = seed();
  logCall(db, "what do you pay for copper");
  mineChecks(db, "s1");

  const first = runAnswerChecks(db, "s1");
  assert.equal(first.ran, 1);
  assert.equal(first.pass, 1, "the question answers against the data it was mined from");

  // A sync that swapped in an empty batch: the classic silent breakage.
  db.prepare("UPDATE sources SET active_batch_id = 'b2' WHERE id = 's1'").run();
  const broken = runAnswerChecks(db, "s1");
  assert.equal(broken.regressed, 1);

  const sum = checksSummary(db, "s1");
  assert.equal(sum.regressed.length, 1);
  assert.match(sum.regressed[0].detail, /now returns nothing/i);

  // Running again must NOT quietly re-baseline the failure away.
  const again = runAnswerChecks(db, "s1");
  assert.equal(again.regressed, 1, "a regression must stay visible until it is actually fixed");
  assert.equal(checksSummary(db, "s1").regressed.length, 1);
});

test("a recovered source goes back to passing", () => {
  const db = seed();
  logCall(db, "what do you pay for copper");
  mineChecks(db, "s1");
  runAnswerChecks(db, "s1");
  db.prepare("UPDATE sources SET active_batch_id = 'b2' WHERE id = 's1'").run();
  assert.equal(runAnswerChecks(db, "s1").regressed, 1);
  db.prepare("UPDATE sources SET active_batch_id = 'b1' WHERE id = 's1'").run();
  assert.equal(runAnswerChecks(db, "s1").pass, 1);
  assert.equal(checksSummary(db, "s1").regressed.length, 0);
});

test("an unsynced source is skipped rather than reported as broken", () => {
  const db = seed();
  db.prepare("UPDATE sources SET active_batch_id = NULL WHERE id = 's1'").run();
  assert.deepEqual(runAnswerChecks(db, "s1"), { ran: 0, pass: 0, changed: 0, regressed: 0 });
});
