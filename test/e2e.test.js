import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

test("full journey: signup -> connect -> csv source -> tool call answers Tacoma question", async () => {
  const t = await startTestApp();
  const hdrs = (cookie) => ({ "content-type": "application/json", "x-requested-with": "kb-bridge", ...(cookie ? { cookie } : {}) });

  let res = await fetch(`${t.base}/signup`, { method: "POST", headers: hdrs(), body: JSON.stringify({ email: "dealer@riva.com", password: "longenough1" }) });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  await fetch(`${t.base}/connect`, { method: "POST", headers: hdrs(cookie), body: JSON.stringify({ api_key: "ak-real-looking" }) });

  res = await fetch(`${t.base}/sources/new`, { method: "POST", headers: hdrs(cookie), body: JSON.stringify({
    type: "csv", name: "Riverside Inventory", schedule_minutes: 1440,
    csv_text: [
      "make,model,year,price,mileage,vin,color",
      'Toyota,Tacoma,2022,"$28,500",31000,VIN001,Silver',
      'Toyota,Tacoma,2021,"$26,900",44000,VIN002,Red',
      'Toyota,Tundra,2023,"$41,000",12000,VIN003,Black',
    ].join("\n"),
    assistant_ids: ["mock-assistant-1"],
  })});
  const { source_id } = await res.json();

  const source = t.db.prepare("SELECT secret FROM sources WHERE id=?").get(source_id);
  // Simulate Assistable's proxy calling the tool exactly per platform contract
  res = await fetch(`${t.base}/api/tools/${source_id}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": source.secret, location_id: "loc1", assistant_id: "a1", call_control_id: "cc1", direction: "inbound" },
    body: JSON.stringify({
      args: { query: "do you have a 2022 tacoma under 30k", make: "Toyota", model: "Tacoma", price_max: 30000, price_min: 0, year_min: 2022, year_max: 2022 },
      meta_data: { tool_id: "t1" }, metadata: {}, call: { call_id: "cc1", retell_llm_dynamic_variables: {} },
    }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
  assert.equal(out.items[0].price, 28500);
  assert.match(out.speech_hint, /Tacoma/i);
  assert.ok(JSON.stringify(out).length < 1600, "voice-sized response");
  t.srv.close();
});
