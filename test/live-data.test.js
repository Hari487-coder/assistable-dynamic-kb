import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { fetchWebTableRows } from "../src/connectors/webtable.js";
import { fetchFeedItems } from "../src/connectors/feed.js";
import { crawlSiteItems } from "../src/connectors/website.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { searchStructured } from "../src/search/structured.js";
import { openDb } from "../src/db.js";
import { startTestApp } from "./helpers.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const htmlRes = (text, ct = "text/html") => ({ status: 200, headers: new Map([["content-type", ct]]), text });

test("webtable: scrap price page becomes filterable rows (largest table wins, nav table ignored)", async () => {
  const fetchImpl = async () => htmlRes(fx("scrap-prices.html"));
  const { rows } = await fetchWebTableRows({ url: "https://scrapco.example.com/prices" }, { fetchImpl });
  assert.equal(rows.length, 8);
  assert.deepEqual(Object.keys(rows[0]), ["material", "category", "price_per_lb"]);
  assert.equal(rows[0].material, "Bare Bright Copper");
  const meta = inferColumnMeta(rows);
  const by = Object.fromEntries(meta.map((c) => [c.name, c]));
  assert.equal(by.price_per_lb.kind, "numeric", "$3.85 must parse numeric");
  assert.equal(by.category.kind, "categorical");
});

test("webtable end-to-end: 'what do you pay for copper' answers from live table", async () => {
  const fetchImpl = async () => htmlRes(fx("scrap-prices.html"));
  const { rows } = await fetchWebTableRows({ url: "https://x.example.com/p" }, { fetchImpl });
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(rows);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','webtable','Scrap Prices','ct','sec','active','b1',?,?,60,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of rows) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  const source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  const r = searchStructured(db, source, { query: "bare bright copper price", filters: {} });
  assert.ok(r.resultCount >= 1);
  assert.equal(r.items[0].structured.price_per_lb, 3.85);
  const cat = searchStructured(db, source, { query: "", filters: { category: "Copper" } });
  assert.equal(cat.resultCount, 4);
});

test("webtable: header markup (style/footnotes) never becomes a column name", async () => {
  const html = `<html><body><table>
    <tr>
      <th><style>.mw-parser-output .tooltip-dotted{border-bottom:1px dotted}</style>Car</th>
      <th>Price<sup>[a]</sup></th>
      <th><style>.mw-parser-output .other-junk{color:red}</style></th>
    </tr>
    <tr><td>Ferrari 250 GTO</td><td>US$70,000,000</td><td>x</td></tr>
    <tr><td>Mercedes 300 SLR</td><td>US$143,000,000</td><td>y</td></tr>
  </table></body></html>`;
  const { rows } = await fetchWebTableRows({ url: "https://x.example.com" }, { fetchImpl: async () => htmlRes(html) });
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["car", "price", "col_3"]);
});

test("webtable rejects non-HTML and table-less pages", async () => {
  await assert.rejects(
    fetchWebTableRows({ url: "https://x.example.com/x.pdf" }, { fetchImpl: async () => htmlRes("%PDF-1.4", "application/pdf") }),
    (e) => e.permanent === true);
  await assert.rejects(
    fetchWebTableRows({ url: "https://x.example.com" }, { fetchImpl: async () => htmlRes("<html><body><p>no tables</p></body></html>") }),
    /no data table/i);
});

test("feed: shopify-style nested variants explode into per-variant rows", async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Map([["content-type", "application/json"]]), text: fx("shopify-feed.json") });
  const { rows } = await fetchFeedItems({ url: "https://shop.example.com/products.json" }, { fetchImpl });
  assert.equal(rows.length, 4, "3 hoodie variants + 1 tee variant");
  const blkM = rows.find((r) => r.variant_sku === "H-BLK-M");
  assert.ok(blkM);
  assert.equal(blkM.title, "Classic Hoodie", "parent fields inherited");
  assert.equal(blkM.variant_inventory_quantity, 12);
  const meta = inferColumnMeta(rows);
  const by = Object.fromEntries(meta.map((c) => [c.name, c]));
  assert.equal(by.variant_inventory_quantity.kind, "numeric", "stock must be filterable");
});

test("website crawler skips non-HTML responses (no junk chunks from PDFs)", async () => {
  const pages = {
    "https://d.example.com/": htmlRes('<html><body><h1>Home</h1><p>Welcome to our shop.</p><a href="/menu.pdf">Menu</a></body></html>'),
    "https://d.example.com/menu.pdf": htmlRes("%PDF-1.4 binary junk h1 p", "application/pdf"),
    "https://d.example.com/robots.txt": { status: 404, headers: new Map(), text: "" },
  };
  const fetchImpl = async (url) => pages[url] ?? { status: 404, headers: new Map(), text: "" };
  const { rows } = await crawlSiteItems({ url: "https://d.example.com/" }, { fetchImpl });
  assert.ok(rows.every((r) => !/PDF-1\.4/.test(r.content)), "pdf content must not become chunks");
});

test("push API: refresh and content push with separate secret; tool secret rejected", async () => {
  const t = await startTestApp();
  const H = { "content-type": "application/json", "x-requested-with": "kb-bridge", cookie: t.ownerCookie };
  let res = await fetch(`${t.base}/connect`, { method: "POST", headers: H, body: JSON.stringify({ api_key: "ak-push-test" }) });
  res = await fetch(`${t.base}/sources/new`, { method: "POST", headers: H, body: JSON.stringify({
    type: "csv", name: "Scrap Prices", schedule_minutes: 60,
    csv_text: "material,price_per_lb\nBare Bright Copper,$3.85\nBrass,$2.10",
    assistant_ids: [],
  })});
  const { source_id } = await res.json();
  const src = t.db.prepare("SELECT secret, push_secret FROM sources WHERE id=?").get(source_id);
  assert.ok(src.push_secret && src.push_secret !== src.secret, "push secret must exist and differ from tool secret");

  // tool secret must NOT authorize pushes
  res = await fetch(`${t.base}/api/push/${source_id}/refresh`, { method: "POST", headers: { "x-push-secret": src.secret } });
  assert.equal(res.status, 404);

  // refresh with the push secret -> 202
  res = await fetch(`${t.base}/api/push/${source_id}/refresh`, { method: "POST", headers: { "x-push-secret": src.push_secret } });
  assert.equal(res.status, 202);

  // live price change pushed directly -> answers change immediately
  res = await fetch(`${t.base}/api/push/${source_id}/content`, {
    method: "POST",
    headers: { "x-push-secret": src.push_secret, "content-type": "text/csv" },
    body: "material,price_per_lb\nBare Bright Copper,$3.99\nBrass,$2.15",
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.items_count, 2);

  const tool = await fetch(`${t.base}/api/tools/${source_id}/search`, {
    method: "POST", headers: { "content-type": "application/json", "x-bridge-secret": src.secret },
    body: JSON.stringify({ args: { query: "bare bright copper" }, meta_data: {}, metadata: {}, call: {} }),
  });
  const answer = await tool.json();
  assert.equal(answer.items[0].price_per_lb, 3.99, "agent must speak the pushed price");
  t.srv.close();
});
