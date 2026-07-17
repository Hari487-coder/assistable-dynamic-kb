import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

test("loadConfig validates and defaults", () => {
  const c = loadConfig({ ENCRYPTION_KEY: KEY, BASE_URL: "https://kb.example.com" });
  assert.equal(c.port, 3900);
  assert.equal(c.mockAssistable, true);
  assert.equal(c.baseUrl, "https://kb.example.com");
});

test("loadConfig rejects bad key", () => {
  assert.throws(() => loadConfig({ ENCRYPTION_KEY: "short" }), /ENCRYPTION_KEY/);
});

test("logger redacts secrets", () => {
  const lines = [];
  const log = createLogger({ write: (s) => lines.push(s) });
  log.info("x", { api_key: "sk-123", email: "a@b.c", authorization: "Bearer y" });
  const out = JSON.parse(lines[0]);
  assert.equal(out.api_key, "[redacted]");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.email, "a@b.c");
});
