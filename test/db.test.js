import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, tx } from "../src/db.js";

test("schema creates all tables and FTS stays in sync", () => {
  const db = openDb(":memory:");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ["users","sessions","connections","sources","items","sync_runs","tools","tool_calls","audit_log"]) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,schedule_minutes,secret,status,created_at)
              VALUES ('s1','u1','csv','inv','ct',1440,'sec','never_synced','2026-01-01')`).run();
  db.prepare(`INSERT INTO items (id,source_id,batch_id,title,body,structured_json)
              VALUES ('i1','s1','b1','2022 Toyota Tacoma','2022 Toyota Tacoma SR5 28500','{}')`).run();
  const hit = db.prepare(`SELECT rowid FROM items_fts WHERE items_fts MATCH 'tacoma'`).all();
  assert.equal(hit.length, 1);
  db.prepare(`DELETE FROM items WHERE id='i1'`).run();
  assert.equal(db.prepare(`SELECT count(*) c FROM items_fts WHERE items_fts MATCH 'tacoma'`).get().c, 0);
});

test("openDb is idempotent and tx commits/rolls back", () => {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  tx(db, () => {
    db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u2','c@d.e','h','2026-01-01')`).run();
  });
  assert.equal(db.prepare("SELECT count(*) c FROM users").get().c, 2);
  assert.throws(() =>
    tx(db, () => {
      db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u3','e@f.g','h','2026-01-01')`).run();
      throw new Error("boom");
    })
  );
  assert.equal(db.prepare("SELECT count(*) c FROM users").get().c, 2);
});
