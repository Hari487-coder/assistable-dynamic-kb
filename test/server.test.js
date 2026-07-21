import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import { openDb } from "../src/db.js";

test("app boots, healthz ok, security headers set, 404 handled", async () => {
  const app = buildApp({
    db: openDb(":memory:"),
    config: { encryptionKey: Buffer.alloc(32, 1).toString("base64"), baseUrl: "http://t", dataDir: "./data", nodeEnv: "test", mockAssistable: true, port: 0 },
    logger: { info() {}, warn() {}, error() {} },
  });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'self'"));
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
  srv.close();
});

test("a real-world CSV (>256KB) uploads through /sources/new without a 413", async () => {
  const app = buildApp({
    db: openDb(":memory:"),
    config: { encryptionKey: Buffer.alloc(32, 1).toString("base64"), baseUrl: "http://t", dataDir: "./data", nodeEnv: "test", mockAssistable: true, port: 0, signups: "open" },
    logger: { info() {}, warn() {}, error() {} },
  });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { "content-type": "application/json", "x-requested-with": "kb-bridge" };
  const signup = await fetch(`${base}/signup`, { method: "POST", headers: H, body: JSON.stringify({ email: "o@x.co", password: "longenough1" }) });
  const cookie = signup.headers.get("set-cookie")?.split(";")[0];
  // ~700KB of CSV - a normal inventory export, well over the old 256kb JSON cap.
  const csv = "make,model,price\n" + Array.from({ length: 20000 }, (_, i) => `Toyota,Model${i},$${20000 + i}`).join("\n");
  const res = await fetch(`${base}/sources/new`, {
    method: "POST", headers: { ...H, cookie },
    body: JSON.stringify({ type: "csv", name: "Big inventory", schedule_minutes: 1440, csv_text: csv, assistant_ids: [] }),
  });
  assert.notEqual(res.status, 413, "the JSON parser cap must not reject a legal 5MB csv_text");
  const out = await res.json();
  assert.equal(out.ok, true);
  srv.close();
});
