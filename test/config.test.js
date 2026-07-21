import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("loadConfig knows whether the encryption key survives a disk wipe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbcfg-"));
  assert.equal(loadConfig({ ENCRYPTION_KEY: KEY }).encryptionKeyFromEnv, true);
  assert.equal(loadConfig({ DATA_DIR: dir }, { autoKey: true }).encryptionKeyFromEnv, false);
  assert.equal(loadConfig({ SETUP_TOKEN: "t", ENCRYPTION_KEY: KEY }).setupToken, "t");
  fs.rmSync(dir, { recursive: true, force: true });
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
