import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { hashPassword, verifyPassword, createUser, createSession, sessionUser, csrfCheck } from "../src/auth.js";
import { ownedSource } from "../src/tenant.js";

test("password hash + verify", async () => {
  const h = await hashPassword("hunter2hunter2");
  assert.ok(h.startsWith("$2"));
  assert.equal(await verifyPassword("hunter2hunter2", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
});

test("signup validation", async () => {
  const db = openDb(":memory:");
  await assert.rejects(createUser(db, "notanemail", "longenough1"), /email/i);
  await assert.rejects(createUser(db, "a@b.co", "short"), /10/);
  const u = await createUser(db, "a@b.co", "longenough1");
  await assert.rejects(createUser(db, "A@B.CO", "longenough1"), /exists/i);
  assert.ok(u.id);
});

test("session create/resolve/expiry", async () => {
  const db = openDb(":memory:");
  const u = await createUser(db, "a@b.co", "longenough1");
  const token = createSession(db, u.id);
  assert.equal(sessionUser(db, token).id, u.id);
  assert.equal(sessionUser(db, "bogus"), null);
  db.prepare("UPDATE sessions SET expires_at='2020-01-01T00:00:00Z'").run();
  assert.equal(sessionUser(db, token), null);
});

test("csrfCheck requires custom header on mutations", () => {
  assert.equal(csrfCheck({ method: "GET", get: () => undefined }), true);
  assert.equal(csrfCheck({ method: "POST", get: () => undefined }), false);
  assert.equal(csrfCheck({ method: "POST", get: (h) => h === "x-requested-with" ? "kb-bridge" : undefined }), true);
});

test("tenant isolation: ownedSource", async () => {
  const db = openDb(":memory:");
  const u1 = await createUser(db, "a@b.co", "longenough1");
  const u2 = await createUser(db, "c@d.co", "longenough1");
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES ('s1',?,'csv','inv','ct','sec','2026-01-01')`).run(u1.id);
  assert.ok(ownedSource(db, u1.id, "s1"));
  assert.equal(ownedSource(db, u2.id, "s1"), null); // IDOR blocked
});
