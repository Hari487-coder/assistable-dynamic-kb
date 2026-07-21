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

test("parseNumericLike: currency-prefixed prices (UK/EU/Wikipedia styles)", () => {
  assert.equal(parseNumericLike("£7.20"), 7.2);
  assert.equal(parseNumericLike("US$143,000,000"), 143000000);
  assert.equal(parseNumericLike("GBP 7.20"), 7.2);
  assert.equal(parseNumericLike("€1,250"), 1250);
  assert.equal(parseNumericLike("₹1,200"), 1200);
  assert.equal(parseNumericLike("£12k"), 12000);
  // bare code + digits without a currency marker stays text ("US1" is a name)
  assert.equal(parseNumericLike("US1"), null);
});

// detectCurrency advertises A$ and CA$, so the parser has to accept both or an
// AUD price column silently demotes to text - the exact bug fixed for GBP.
test("parseNumericLike: dollar-symbol currencies parse to the same number", () => {
  assert.equal(parseNumericLike("A$99"), 99);
  assert.equal(parseNumericLike("CA$99"), 99);
  assert.equal(parseNumericLike("AUD 1,499.50"), 1499.5);
  assert.equal(parseNumericLike("NZ$25"), 25);
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

test("£-priced column stays numeric with quartiles (copper-site shape)", () => {
  const gbp = [
    { material: "Bare Bright Copper", price_per_kg: "£7.20" },
    { material: "Braziery Copper",    price_per_kg: "£5.10" },
    { material: "Copper Tanks",       price_per_kg: "£6.00" },
    { material: "Household Cable",    price_per_kg: "£2.30" },
  ];
  const by = Object.fromEntries(inferColumnMeta(gbp).map((c) => [c.name, c]));
  assert.equal(by.price_per_kg.kind, "numeric");
  assert.equal(by.price_per_kg.min, 2.3);
  assert.equal(by.price_per_kg.max, 7.2);
});

test("title leads with the identity column, not repeating categoricals", () => {
  const auctions = [
    { car: "Mercedes-Benz 300 SLR Uhlenhaut Coupé", price: "US$143,000,000", auction_house: "RM Sotheby's", location: "Stuttgart, Germany" },
    { car: "Ferrari 250 GTO",                        price: "US$70,000,000",  auction_house: "RM Sotheby's", location: "Stuttgart, Germany" },
    { car: "Ferrari 335 S",                          price: "US$35,730,510",  auction_house: "Artcurial",    location: "Paris, France" },
  ];
  const meta = inferColumnMeta(auctions);
  const item = rowToItem(auctions[0], meta);
  assert.ok(item.title.startsWith("Mercedes-Benz 300 SLR"), `got: ${item.title}`);
  assert.equal(item.structured.price, 143000000);
});

test("near-unique short text columns are identityish; ID codes are not", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    headline: `Fancy Widget ${String.fromCharCode(65 + i)} Deluxe`,
    vin: `VIN${1000 + i}`,
  }));
  const by = Object.fromEntries(inferColumnMeta(many).map((c) => [c.name, c]));
  assert.equal(by.headline.identityish, true);
  assert.ok(!by.vin.identityish, "VIN-style codes must not title rows");
  const item = rowToItem(many[0], inferColumnMeta(many));
  assert.ok(item.title.startsWith("Fancy Widget A Deluxe"), `got: ${item.title}`);
});
