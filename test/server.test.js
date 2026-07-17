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
