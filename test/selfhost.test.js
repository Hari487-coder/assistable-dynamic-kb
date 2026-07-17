import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { loadConfig, resolveEncryptionKey } from "../src/config.js";
import { openDb } from "../src/db.js";
import { cookieParser } from "../src/auth.js";
import { createDashboardRouter } from "../src/routes/dashboard.js";
import { AssistableClient } from "../src/assistable/client.js";

const noopLog = { info() {}, warn() {}, error() {} };

test("resolveEncryptionKey: generates on first boot, persists across restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbtest-"));
  const k1 = resolveEncryptionKey({}, dir);
  assert.equal(Buffer.from(k1, "base64").length, 32);
  const k2 = resolveEncryptionKey({}, dir);
  assert.equal(k1, k2, "same key on restart");
  assert.equal(resolveEncryptionKey({ ENCRYPTION_KEY: "env-wins" }, dir), "env-wins");
  const cfg = loadConfig({ DATA_DIR: dir }, { autoKey: true });
  assert.equal(cfg.encryptionKey, k1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RENDER_EXTERNAL_URL used as baseUrl fallback", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const c = loadConfig({ ENCRYPTION_KEY: KEY, RENDER_EXTERNAL_URL: "https://my-kb.onrender.com/" });
  assert.equal(c.baseUrl, "https://my-kb.onrender.com");
});

test("signups=first-only: first signup works, second is rejected", async () => {
  const db = openDb(":memory:");
  const config = {
    encryptionKey: Buffer.alloc(32, 5).toString("base64"),
    baseUrl: "http://t", dataDir: "./data", nodeEnv: "test", signups: "first-only",
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser);
  app.use(createDashboardRouter({
    db, config, logger: noopLog, connectors: {},
    makeClient: () => new AssistableClient({ apiKey: "x", mock: true, logger: noopLog }),
  }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(`${base}/signup`, {
    method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge" },
    body: JSON.stringify(body),
  });
  const first = await post({ email: "owner@self.host", password: "longenough1" });
  assert.equal(first.status, 200);
  const second = await post({ email: "intruder@x.co", password: "longenough1" });
  assert.equal(second.status, 403);
  assert.match((await second.json()).error, /closed/i);
  srv.close();
});
