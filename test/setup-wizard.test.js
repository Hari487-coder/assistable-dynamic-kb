import { test, before } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

let t, cookie;
before(async () => {
  t = await startTestApp();
  const res = await fetch(`${t.base}/signup`, {
    method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge" },
    body: JSON.stringify({ email: "wizard@x.co", password: "longenough1" }),
  });
  cookie = res.headers.get("set-cookie").split(";")[0];
});

const H = () => ({ "content-type": "application/json", "x-requested-with": "kb-bridge", cookie });

test("setup page shows to-do state, then done state after connect + source", async () => {
  let html = await (await fetch(`${t.base}/setup`, { headers: { cookie } })).text();
  assert.match(html, /Connect your Assistable account/);
  assert.match(html, /to do/);

  await fetch(`${t.base}/connect`, { method: "POST", headers: H(), body: JSON.stringify({ api_key: "ak-wizard-123" }) });
  let res = await fetch(`${t.base}/sources/new`, { method: "POST", headers: H(), body: JSON.stringify({
    type: "csv", name: "Wizard Inventory", schedule_minutes: 1440,
    csv_text: "make,model,year,price\nToyota,Tacoma,2022,\"$28,500\"",
    assistant_ids: ["mock-assistant-1"],
  })});
  assert.equal((await res.json()).ok, true);

  html = await (await fetch(`${t.base}/setup`, { headers: { cookie } })).text();
  assert.match(html, /done/);
  assert.match(html, /Wizard Inventory/);
  assert.match(html, /mock-tool-/);
  assert.match(html, /ALWAYS call the live_data_Wizard_Inventory tool/);
});

test("test endpoint answers via the same engine, session-authed", async () => {
  const src = t.db.prepare("SELECT id FROM sources WHERE name='Wizard Inventory'").get();
  const res = await fetch(`${t.base}/sources/${src.id}/test`, { method: "POST", headers: H(), body: JSON.stringify({ query: "2022 tacoma" }) });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
  assert.match(out.speech_hint, /Tacoma/);
  // IDOR: another user cannot use the test endpoint
  const res2 = await fetch(`${t.base}/signup`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge" }, body: JSON.stringify({ email: "other@x.co", password: "longenough1" }) });
  const cookie2 = res2.headers.get("set-cookie").split(";")[0];
  const res3 = await fetch(`${t.base}/sources/${src.id}/test`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge", cookie: cookie2 }, body: JSON.stringify({ query: "x" }) });
  assert.equal(res3.status, 404);
  t.srv.close();
});
