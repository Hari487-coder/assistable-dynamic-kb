import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { searchStructured } from "../src/search/structured.js";

// A live scrap marketplace lost its best-paying yard to a naming coincidence:
// one yard is called "Peak Copper Prices Bournemouth". Asked "best price for
// copper piping", the text leg matched "price" against that NAME, so the only
// row returned was that yard's - at 8.95 - while the yard actually paying 9.30
// never appeared. The word "price" says which COLUMN the caller means, not
// which row, and a column's own name must never decide the result set.
const ROWS = [
  { yard_name: "Peak Copper Prices Bournemouth", area: "Bournemouth", grade: "Copper Piping", price_per_kg: 8.95 },
  { yard_name: "Benfleet Scrap Co - Basildon", area: "Essex", grade: "Copper Piping", price_per_kg: 9.30 },
  { yard_name: "AI Group Metal Recycling", area: "Wokingham", grade: "Copper Piping", price_per_kg: 7.30 },
  { yard_name: "Peak Copper Prices Bournemouth", area: "Bournemouth", grade: "Brass", price_per_kg: 4.10 },
  { yard_name: "Benfleet Scrap Co - Basildon", area: "Essex", grade: "Brass", price_per_kg: 5.20 },
];

let db, source;
before(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')").run();
  const columns = inferColumnMeta(ROWS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','database','Scrap Copper Prices','ct','sec','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(columns), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  ROWS.forEach((row, i) => {
    const item = rowToItem(row, columns);
    ins.run(`i${i}`, "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  });
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("a column's own name never narrows the result set to a yard that shares the word", () => {
  const res = searchStructured(db, source, { query: "best price for copper piping" });
  const names = res.items.map((i) => i.structured.yard_name);
  assert.ok(res.resultCount > 1, `expected every Copper Piping yard, got ${res.resultCount}: ${names.join(", ")}`);
  assert.ok(names.includes("Benfleet Scrap Co - Basildon"),
    `the yard paying the most (9.30) must be reachable, got: ${names.join(", ")}`);
});

test("asking who pays the most still ranks by price, highest first", () => {
  const res = searchStructured(db, source, { query: "who pays the most for copper piping" });
  assert.equal(res.items[0].structured.yard_name, "Benfleet Scrap Co - Basildon");
  assert.equal(res.items[0].structured.price_per_kg, 9.3);
});

test("a yard is still findable by its own name", () => {
  const res = searchStructured(db, source, { query: "Benfleet" });
  assert.ok(res.items.length > 0, "searching a yard by name must still work");
  for (const item of res.items) assert.match(item.structured.yard_name, /Benfleet/);
});

test("grade words that also appear in a column name are kept as content", () => {
  // "grade" is a column here; "Copper Piping" is a VALUE. Dropping structural
  // words must never strip the value the caller actually asked for.
  const res = searchStructured(db, source, { query: "copper piping" });
  assert.ok(res.items.length > 0);
  for (const item of res.items) assert.equal(item.structured.grade, "Copper Piping");
});
