import { test, before } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";
import { decryptSecret } from "../src/crypto.js";

let t;
before(async () => { t = await startTestApp(); });

async function post(path, body, cookie) {
  return fetch(`${t.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-requested-with": "kb-bridge", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("signup -> login -> connect (mock) -> create csv source -> tool provisioned", async () => {
  let res = await post("/signup", { email: "o@d.co", password: "longenough1" });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  res = await post("/connect", { api_key: "ak-test-123" }, cookie);
  assert.equal((await res.json()).ok, true);

  res = await post("/sources/new", {
    type: "csv", name: "Inventory", schedule_minutes: 1440,
    csv_text: "make,model,year,price\nToyota,Tacoma,2022,\"$28,500\"\nHonda,Civic,2021,\"$19,900\"",
    assistant_ids: ["mock-assistant-1"],
  }, cookie);
  const created = await res.json();
  assert.equal(created.ok, true);

  const src = t.db.prepare("SELECT * FROM sources WHERE name='Inventory'").get();
  assert.equal(src.status, "active");
  const tool = t.db.prepare("SELECT * FROM tools WHERE source_id=?").get(src.id);
  assert.match(tool.tool_id, /^mock-tool-/);
});

test("re-submitting the same source name is a 409, not a duplicate", async () => {
  let res = await post("/signup", { email: "dup@d.co", password: "longenough1" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const body = {
    type: "csv", name: "Scrap Prices", schedule_minutes: 1440,
    csv_text: "material,price\nCopper,\"£7.20\"", assistant_ids: [],
  };
  res = await post("/sources/new", body, cookie);
  assert.equal((await res.json()).ok, true);
  res = await post("/sources/new", body, cookie);
  assert.equal(res.status, 409, "the six-identical-sources incident must be impossible");
  const out = await res.json();
  assert.match(out.error, /already have a source/i);
  const count = t.db.prepare("SELECT count(*) c FROM sources WHERE name = 'Scrap Prices'").get().c;
  assert.equal(count, 1);
});

test("a key-protected feed keeps its auth header (stored encrypted)", async () => {
  let res = await post("/signup", { email: "feed@d.co", password: "longenough1" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  res = await post("/sources/new", {
    type: "feed", name: "Partner price feed", schedule_minutes: 60,
    url_feed: "https://partner.example.com/prices.json",
    auth_header_name: "x-api-key", auth_header_value: "secret-key-123",
    assistant_ids: [],
  }, cookie);
  const { source_id } = await res.json();
  const row = t.db.prepare("SELECT config_ct FROM sources WHERE id = ?").get(source_id);
  assert.ok(!row.config_ct.includes("secret-key-123"), "the feed key must not sit in plaintext");
  const cfg = JSON.parse(decryptSecret(row.config_ct, Buffer.alloc(32, 5).toString("base64")));
  assert.deepEqual(cfg.authHeader, { name: "x-api-key", value: "secret-key-123" });
});

test("widget bench is owner-only and relaxes CSP just for the embed", async () => {
  let res = await fetch(`${t.base}/widget-test`, { redirect: "manual" });
  assert.equal(res.status, 302, "strangers are sent to login - no credit-draining public chat");
  res = await post("/signup", { email: "bench@d.co", password: "longenough1" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  res = await fetch(`${t.base}/widget-test`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /chat-widget-v2\.js/, "embeds the V2 widget loader");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src \*/, "CSP relaxed so the third-party widget can load");
});

test("CSRF: mutation without header is rejected", async () => {
  const res = await fetch(`${t.base}/sources/new`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.ok([302, 403].includes(res.status));
});

test("IDOR: second user cannot see or sync first user's source", async () => {
  let res = await post("/signup", { email: "evil@d.co", password: "longenough1" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const src = t.db.prepare("SELECT id FROM sources WHERE name='Inventory'").get();
  res = await fetch(`${t.base}/sources/${src.id}`, { headers: { cookie } });
  assert.equal(res.status, 404);
  res = await post(`/sources/${src.id}/sync`, {}, cookie);
  assert.equal(res.status, 404);
});

test("api key never echoed back", async () => {
  const res = await fetch(`${t.base}/connect`, { headers: { cookie: t.ownerCookie } });
  const html = await res.text();
  assert.ok(!html.includes("ak-test-123"));
  t.srv.close();
});
