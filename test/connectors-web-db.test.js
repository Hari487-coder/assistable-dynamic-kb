import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crawlSiteItems } from "../src/connectors/website.js";
import { fetchDbItems } from "../src/connectors/database.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("crawler: same-origin BFS, heading chunks, external links ignored", async () => {
  const pages = {
    "https://dealer.example.com/": fx("site-home.html"),
    "https://dealer.example.com/specials": fx("site-specials.html"),
    "https://dealer.example.com/robots.txt": "User-agent: *\nDisallow: /admin",
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    return pages[url] !== undefined
      ? { status: 200, headers: new Map([["content-type", "text/html"]]), text: pages[url] }
      : { status: 404, headers: new Map(), text: "" };
  };
  const { rows } = await crawlSiteItems({ url: "https://dealer.example.com/" }, { fetchImpl });
  assert.ok(rows.some((r) => /0\.9% APR/.test(r.content)));
  assert.ok(rows.some((r) => r.heading.includes("Service Department")));
  assert.ok(!fetched.some((u) => u.includes("other.example.com")));
});

test("crawler respects robots Disallow", async () => {
  const fetchImpl = async (url) => url.endsWith("robots.txt")
    ? { status: 200, headers: new Map(), text: "User-agent: *\nDisallow: /" }
    : { status: 200, headers: new Map([["content-type", "text/html"]]), text: "<h1>x</h1>" };
  await assert.rejects(crawlSiteItems({ url: "https://x.example.com/" }, { fetchImpl }), /robots/i);
});

test("db connector: ident validation + SELECT-only template", async () => {
  await assert.rejects(fetchDbItems({ connectionString: "postgres://x", table: "cars; DROP TABLE users" }), /table name/i);
  const queries = [];
  const pgClientFactory = () => ({
    connect: async () => {},
    query: async (q) => { queries.push(q); return { rows: [{ id: 1, model: "Tacoma" }] }; },
    end: async () => {},
  });
  const { rows } = await fetchDbItems({ connectionString: "postgres://x", table: "public.inventory" }, { pgClientFactory });
  assert.equal(rows[0].model, "Tacoma");
  assert.ok(queries.some((q) => /SET statement_timeout = 5000/.test(q)));
  assert.ok(queries.some((q) => q === "SELECT * FROM public.inventory LIMIT 20000"));
});
