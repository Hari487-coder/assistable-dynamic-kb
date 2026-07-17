import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { runSync, classifyError, recoverStuckRuns, rollbackSource } from "../src/sync/engine.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const noopLog = { info() {}, warn() {}, error() {} };

function mkDeps(db, rowsOrFn) {
  return {
    db, logger: noopLog,
    config: { encryptionKey: KEY, dataDir: "./data" },
    connectors: { csv: async () => (typeof rowsOrFn === "function" ? rowsOrFn() : { rows: rowsOrFn }) },
  };
}

function mkSource(db, id = "s1") {
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES (?,'u1','csv','inv',?,'sec','2026-01-01')`).run(id, encryptSecret(JSON.stringify({}), KEY));
}

const ROWS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900" },
];

test("successful sync swaps batch and infers columns", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  const r = await runSync(mkDeps(db, ROWS), "s1", {});
  assert.equal(r.ok, true);
  const src = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  assert.equal(src.status, "active");
  assert.ok(src.active_batch_id);
  assert.equal(db.prepare("SELECT count(*) c FROM items WHERE source_id='s1' AND batch_id=?").get(src.active_batch_id).c, 2);
  const meta = JSON.parse(src.column_meta_json);
  assert.ok(meta.find((c) => c.name === "price" && c.kind === "numeric"));
});

test("shrink gate: refuses swap on empty fetch", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  const before = db.prepare("SELECT active_batch_id FROM sources WHERE id='s1'").get().active_batch_id;
  const r = await runSync(mkDeps(db, []), "s1", {});
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT active_batch_id FROM sources WHERE id='s1'").get().active_batch_id, before);
});

test("transient failure ladder marks stale after 3", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  const failing = mkDeps(db, () => { throw new Error("ECONNRESET"); });
  await runSync(failing, "s1", {}); await runSync(failing, "s1", {}); await runSync(failing, "s1", {});
  const src = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  assert.equal(src.status, "stale");
  assert.equal(src.consecutive_failures, 3);
  assert.ok(src.active_batch_id, "old batch still serving");
});

test("classifyError", () => {
  const p = new Error("x"); p.permanent = true;
  assert.equal(classifyError(p), "permanent");
  assert.equal(classifyError(new Error("feed returned HTTP 403")), "permanent");
  assert.equal(classifyError(new Error("feed returned HTTP 429")), "transient");
  assert.equal(classifyError(new Error("ETIMEDOUT")), "transient");
});

test("crash recovery marks stuck running syncs failed", () => {
  const db = openDb(":memory:");
  mkSource(db);
  db.prepare(`INSERT INTO sync_runs (id,source_id,started_at,heartbeat_at,status)
              VALUES ('r1','s1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','running')`).run();
  db.prepare("UPDATE sources SET status='syncing' WHERE id='s1'").run();
  recoverStuckRuns(db);
  assert.equal(db.prepare("SELECT status FROM sync_runs WHERE id='r1'").get().status, "failed");
  assert.notEqual(db.prepare("SELECT status FROM sources WHERE id='s1'").get().status, "syncing");
});

test("rollback swaps prev batch back", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  await runSync(mkDeps(db, [ROWS[0]]), "s1", { force: true });
  const before = db.prepare("SELECT active_batch_id, prev_batch_id FROM sources WHERE id='s1'").get();
  rollbackSource(db, "s1");
  const after = db.prepare("SELECT active_batch_id, prev_batch_id FROM sources WHERE id='s1'").get();
  assert.equal(after.active_batch_id, before.prev_batch_id);
});
