import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AssistableClient, explainAssistableError } from "../src/assistable/client.js";
import { openDb } from "../src/db.js";
import { cookieParser } from "../src/auth.js";
import { createDashboardRouter } from "../src/routes/dashboard.js";

const noop = { info() {}, warn() {}, error() {} };

// Verified against platform source: Bearer is the only accepted auth header
// (managed-api-key-auth.ts:67-77) and every v3 route runs requireSubAccount,
// which 400s unless the key resolves to one subaccount (require-scope.ts:85-106).
test("client sends Bearer only, plus X-Subaccount-Id when configured", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(opts.headers);
    return { status: 200, json: async () => ({ data: [{ id: "a1" }], error: null }) };
  };
  await new AssistableClient({ apiKey: "k1", base: "https://api.test", logger: noop, fetchImpl }).listAssistants();
  assert.equal(seen[0].authorization, "Bearer k1");
  assert.ok(!("x-api-key" in seen[0]), "x-api-key is dead weight - the API never reads it");
  assert.ok(!("x-subaccount-id" in seen[0]), "omitted when not configured");

  await new AssistableClient({ apiKey: "k1", subAccountId: "loc_42", base: "https://api.test", logger: noop, fetchImpl }).listAssistants();
  assert.equal(seen[1]["x-subaccount-id"], "loc_42");
});

test("verifyConnection reports WHY, not just false", async () => {
  const failWith = (status, code, message) => new AssistableClient({
    apiKey: "k", base: "https://api.test", logger: noop,
    fetchImpl: async () => ({ status, json: async () => ({ data: null, error: { code, message } }) }),
  });

  const sub = await failWith(400, "subaccount_required", "Specify the target subaccount").verifyConnection();
  assert.equal(sub.ok, false);
  assert.equal(sub.code, "subaccount_required");
  assert.match(sub.reason, /Subaccount \/ Location ID/);

  const revoked = await failWith(401, "unauthorized", "Invalid or revoked API key").verifyConnection();
  assert.match(revoked.reason, /revoked or expired/);

  const badFormat = await failWith(401, "unauthorized", "Invalid API key format").verifyConnection();
  assert.match(badFormat.reason, /complete Assistable API key/);

  const scope = await failWith(403, "forbidden", "Missing required scope: assistants:list").verifyConnection();
  assert.match(scope.reason, /missing a permission/);
  assert.match(scope.reason, /assistants:list/);

  const ok = await new AssistableClient({
    apiKey: "k", base: "https://api.test", logger: noop,
    fetchImpl: async () => ({ status: 200, json: async () => ({ data: [{ id: "a1" }, { id: "a2" }] }) }),
  }).verifyConnection();
  assert.deepEqual(ok, { ok: true, assistantCount: 2 });
});

test("network failure is reported as unreachable, not as a bad key", async () => {
  const client = new AssistableClient({
    apiKey: "k", base: "https://api.test", logger: noop,
    fetchImpl: async () => { const e = new Error("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; },
  });
  const r = await client.verifyConnection();
  assert.equal(r.ok, false);
  assert.match(r.reason, /Couldn't reach Assistable/);
  assert.match(r.reason, /ENOTFOUND/);
});

test("explainAssistableError covers the remaining statuses", () => {
  assert.match(explainAssistableError({ status: 404 }), /ASSISTABLE_API_BASE/);
  assert.match(explainAssistableError({ status: 429 }), /rate-limiting/);
  assert.match(explainAssistableError({ status: 503 }), /server error/);
  assert.match(explainAssistableError({ status: 403, code: "subaccount_forbidden" }), /isn't allowed to access that subaccount/);
});

test("/connect surfaces the real reason and stores the subaccount id", async () => {
  const db = openDb(":memory:");
  const config = { encryptionKey: Buffer.alloc(32, 3).toString("base64"), baseUrl: "http://t", dataDir: "./data", nodeEnv: "test", signups: "open" };
  let mode = "subaccount_required";
  const makeClient = (apiKey, subAccountId) => new AssistableClient({
    apiKey, subAccountId, base: "https://api.test", logger: noop,
    fetchImpl: async () => (mode === "subaccount_required" && !subAccountId
      ? { status: 400, json: async () => ({ data: null, error: { code: "subaccount_required", message: "Specify the target subaccount" } }) }
      : { status: 200, json: async () => ({ data: [{ id: "a1" }] }) }),
  });
  const app = express();
  app.use(express.json()); app.use(cookieParser);
  app.use(createDashboardRouter({ db, config, logger: noop, connectors: {}, makeClient }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = (cookie) => ({ "content-type": "application/json", "x-requested-with": "kb-bridge", ...(cookie ? { cookie } : {}) });
  const signup = await fetch(`${base}/signup`, { method: "POST", headers: H(), body: JSON.stringify({ email: "o@x.co", password: "longenough1" }) });
  const cookie = signup.headers.get("set-cookie").split(";")[0];

  let res = await fetch(`${base}/connect`, { method: "POST", headers: H(cookie), body: JSON.stringify({ api_key: "ak-multi-subaccount" }) });
  let out = await res.json();
  assert.equal(res.status, 400);
  assert.equal(out.needs_subaccount, true, "UI must know to highlight the subaccount field");
  assert.match(out.error, /Subaccount \/ Location ID/);
  assert.equal(db.prepare("SELECT count(*) c FROM connections").get().c, 0, "a failed probe must not store a connection");

  res = await fetch(`${base}/connect`, { method: "POST", headers: H(cookie), body: JSON.stringify({ api_key: "ak-multi-subaccount", subaccount_id: "loc_42" }) });
  out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(db.prepare("SELECT subaccount_id FROM connections").get().subaccount_id, "loc_42");
  const html = await (await fetch(`${base}/connect`, { headers: { cookie } })).text();
  assert.ok(!html.includes("ak-multi-subaccount"), "key never echoed back");
  srv.close();
});
