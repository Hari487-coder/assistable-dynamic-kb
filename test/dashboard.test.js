import { test, before } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

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
