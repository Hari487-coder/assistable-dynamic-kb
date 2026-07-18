import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { deriveIntent } from "../src/search/intent.js";
import { searchStructured } from "../src/search/structured.js";
import { buildToolResponse } from "../src/search/respond.js";
import { buildToolDefinition } from "../src/assistable/tool-def.js";

// Reproduces the exact shape a real scrap-metal tenant reported: free-text
// question, no typed filters from the LLM, GBP price column, long description
// column. Bugs it locks in: (1) no filters extracted -> 13 loose results;
// (2) speech_hint rendering the literal placeholder "a match".
const GRADES = [
  ["Bright Copper", "Clean uncoated unalloyed shiny copper wire", 7.2, 7.1, 7.05],
  ["Braziery Copper", "Copper with heavy attachments insulation or contamination", 5.4, 5.3, 5.25],
  ["Heavy Brass", "Clean brass fittings taps valves", 4.1, 4.0, 3.95],
  ["Lead", "Clean soft lead sheet and pipe", 1.6, 1.55, 1.5],
];
const AREAS = ["London", "Manchester", "Birmingham"];
const ROWS = GRADES.flatMap(([grade, description, ...prices]) =>
  AREAS.map((area, i) => ({
    grade, description, price_per_kg_gbp: String(prices[i]), area, last_updated: "2026-07-18",
  })));

let db, source, columns;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  columns = inferColumnMeta(ROWS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','webtable','Scrap Prices','ct','sec','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(columns), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of ROWS) {
    const item = rowToItem(row, columns);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("titles stay speakable: short labels, not the whole description", () => {
  const item = rowToItem(ROWS[0], columns);
  assert.equal(item.title, "Bright Copper London");
  assert.ok(!item.title.includes("uncoated"), "long description must not swallow the title");
  assert.ok(item.body.includes("uncoated"), "but it stays searchable in the body");
});

test("deriveIntent extracts category values from a plain spoken question", () => {
  const intent = deriveIntent("what's bright copper going for in london", columns);
  const applied = Object.fromEntries(intent.filters.map((f) => [f.col, f.value]));
  assert.equal(applied.grade, "Bright Copper");
  assert.equal(applied.area, "London");
  assert.ok(intent.filters.every((f) => /from the question/.test(f.note)), "derivation must be disclosed");
});

test("the reported query now answers with ONE row, not 13", () => {
  const r = searchStructured(db, source, { query: "what's bright copper going for in london" });
  assert.equal(r.resultCount, 1);
  assert.equal(r.items[0].structured.price_per_kg_gbp, 7.2);
  assert.equal(r.appliedFilters.grade, "Bright Copper");
  assert.equal(r.appliedFilters.area, "London");
});

test("speech_hint names the item and its price in the right currency", () => {
  const structured = searchStructured(db, source, { query: "what's bright copper going for in london" });
  const out = buildToolResponse({ source, structured, args: {}, tookMs: 1 });
  assert.equal(out.speech_hint, "Yes - we have one match: Bright Copper London at £7.20.");
  assert.ok(!out.speech_hint.includes("a match"), "no literal placeholder");
  assert.ok(!out.speech_hint.includes("$"), "GBP column must not print dollars");
});

test("multi-match hint names both options instead of repeating placeholders", () => {
  const structured = searchStructured(db, source, { query: "bright copper prices" });
  const out = buildToolResponse({ source, structured, args: {}, tookMs: 1 });
  assert.equal(out.result_count, 3, "three areas carry bright copper");
  assert.match(out.speech_hint, /Best fit: Bright Copper \w+ at £7\.\d\d; also Bright Copper \w+ at £7\.\d\d\./);
});

test("longest category value wins (Braziery Copper is not plain Copper)", () => {
  const r = searchStructured(db, source, { query: "braziery copper in manchester" });
  assert.equal(r.resultCount, 1);
  assert.equal(r.items[0].structured.grade, "Braziery Copper");
  assert.equal(r.items[0].structured.area, "Manchester");
});

test("explicit LLM filters still win over anything derived from the text", () => {
  const r = searchStructured(db, source, { query: "bright copper in london", filters: { area: "Manchester" } });
  assert.equal(r.appliedFilters.area, "Manchester");
  assert.equal(r.items[0].structured.area, "Manchester");
});

// Both from the first real conversation transcript (Cooper / scrap copper).
test("a word that names a column is not reported as 'not found in your data'", () => {
  const r = searchStructured(db, source, { query: "bright copper price in london" });
  assert.equal(r.resultCount, 1);
  assert.ok(
    !r.relaxations.some((n) => /ignored "price"/.test(n)),
    'the owner has a price column; saying price is missing reads as a bug'
  );
});

test("long prose columns are not offered as filter params", () => {
  const def = buildToolDefinition({ id: "s1", name: "Scrap Prices" }, columns,
    { baseUrl: "https://kb.test", secret: "s" });
  const props = Object.keys(def.parameters.properties);
  assert.ok(props.includes("grade") && props.includes("area"), "label-sized filters stay");
  assert.ok(!props.includes("description"),
    "a sentence-long column wastes a filter slot and confuses the model");
});
