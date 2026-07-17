import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericLike, inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

test("parseNumericLike", () => {
  assert.equal(parseNumericLike("$24,995"), 24995);
  assert.equal(parseNumericLike("12k"), 12000);
  assert.equal(parseNumericLike("28,500 km"), 28500);
  assert.equal(parseNumericLike("2022"), 2022);
  assert.equal(parseNumericLike("N/A"), null);
  assert.equal(parseNumericLike(""), null);
  assert.equal(parseNumericLike("SR5"), null);
});

const rows = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "V1" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", vin: "V2" },
  { make: "Honda",  model: "Civic",  year: "2021", price: "$19,900", vin: "V3" },
];

test("inferColumnMeta kinds", () => {
  const meta = inferColumnMeta(rows);
  const by = Object.fromEntries(meta.map(c => [c.name, c]));
  assert.equal(by.year.kind, "numeric");
  assert.equal(by.price.kind, "numeric");
  assert.equal(by.price.min, 19900);
  assert.equal(by.price.max, 41000);
  assert.equal(by.make.kind, "categorical");
  assert.deepEqual(by.make.distincts.sort(), ["Honda", "Toyota"]);
});

test("rowToItem builds searchable text + typed structured values", () => {
  const meta = inferColumnMeta(rows);
  const item = rowToItem(rows[0], meta);
  assert.match(item.title, /Toyota/);
  assert.match(item.body, /Tacoma/);
  assert.equal(item.structured.price, 28500);
  assert.equal(item.structured.make, "Toyota");
});
