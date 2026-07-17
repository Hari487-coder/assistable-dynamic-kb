import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsvItems } from "../src/connectors/csv.js";
import { fetchFeedItems } from "../src/connectors/feed.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("csv parses with quoted currency", () => {
  const { rows } = parseCsvItems(fx("inventory.csv"));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].price, "$28,500");
});

test("feed json finds nested array", async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Map([["content-type", "application/json"]]), text: fx("feed.json") });
  const { rows } = await fetchFeedItems({ url: "https://x.com/feed", format: "auto" }, { fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sku, "H-BLK-M");
});

test("feed xml", async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Map([["content-type", "text/xml"]]), text: fx("feed.xml") });
  const { rows } = await fetchFeedItems({ url: "https://x.com/feed.xml", format: "xml" }, { fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, "Gadget");
});

test("feed non-200 throws permanent error", async () => {
  const fetchImpl = async () => ({ status: 403, headers: new Map(), text: "no" });
  await assert.rejects(fetchFeedItems({ url: "https://x.com/f" }, { fetchImpl }), (e) => e.permanent === true);
});
