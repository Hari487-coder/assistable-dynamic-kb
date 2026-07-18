import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildToolDefinition, paramName } from "../src/assistable/tool-def.js";
import { openDb } from "../src/db.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { searchStructured } from "../src/search/structured.js";

// Real spreadsheets have punctuation in their headers. Those column names end
// up as LLM tool-parameter names, and an invalid one makes the provider reject
// the ENTIRE request (400 Invalid 'tools[N].function...') - which takes every
// chat for that assistant dark, not just this tool.
const MESSY = [
  { "Grade / Type": "Bright Copper", "Price per kg (£)": "7.20", "Area (UK)": "London" },
  { "Grade / Type": "Heavy Brass", "Price per kg (£)": "4.10", "Area (UK)": "London" },
  { "Grade / Type": "Bright Copper", "Price per kg (£)": "7.10", "Area (UK)": "Manchester" },
];

const LLM_SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

test("every generated parameter name is LLM-safe", () => {
  const columns = inferColumnMeta(MESSY);
  const def = buildToolDefinition({ id: "s1", name: "Scrap Prices" }, columns, { baseUrl: "https://kb.test", secret: "s" });
  const names = Object.keys(def.parameters.properties);
  assert.ok(names.length > 1, "should advertise filters, not just query");
  for (const n of names) assert.match(n, LLM_SAFE, `unsafe parameter name: ${n}`);
  assert.match(def.name, LLM_SAFE);
});

test("tool is created in the category Assistable's dashboard can edit", () => {
  const def = buildToolDefinition({ id: "s1", name: "Scrap Prices" }, [], { baseUrl: "https://kb.test", secret: "s" });
  // v2's tools PATCH filters on category:"custom"; without it the owner gets
  // "Custom tool not found or cannot be modified" on their own tool.
  assert.equal(def.category, "custom");
});

test("sanitized parameter names still resolve back to their real columns", () => {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const columns = inferColumnMeta(MESSY);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','messy','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(columns), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of MESSY) {
    const item = rowToItem(row, columns);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  const source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();

  // The LLM can only send the sanitized names it was given.
  const gradeParam = paramName("Grade / Type");
  const priceMax = `${paramName("Price per kg (£)")}_max`;
  const r = searchStructured(db, source, { query: "", filters: { [gradeParam]: "Bright Copper", [priceMax]: 7.15 } });
  assert.equal(r.resultCount, 1, "sanitized params must still filter the real columns");
  assert.equal(r.items[0].structured["Area (UK)"], "Manchester");

  // The real column name keeps working too (portal test box, direct API use).
  const raw = searchStructured(db, source, { query: "", filters: { "Grade / Type": "Heavy Brass" } });
  assert.equal(raw.resultCount, 1);
});
