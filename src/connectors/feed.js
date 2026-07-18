import { XMLParser } from "fast-xml-parser";
import { safeFetch } from "../ssrf-guard.js";
import { parseCsvItems } from "./csv.js";

const ARRAY_KEYS = ["data", "items", "products", "inventory", "results", "vehicles", "rows"];

function findArray(node) {
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    for (const k of ARRAY_KEYS) if (Array.isArray(node[k])) return node[k];
    for (const v of Object.values(node)) {
      const found = findArray(v);
      if (found) return found;
    }
  }
  return null;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

// Ecommerce catalogs (Shopify products.json et al) nest sellable units inside
// a parent: one product row with a `variants` array. Stock questions ("is the
// black medium in stock?") need one row PER VARIANT, so explode the first
// array-of-objects field into child rows that inherit the parent's fields.
function explodeNested(rows) {
  const out = [];
  for (const row of rows) {
    const nestedKey = Object.keys(row).find(
      (k) => Array.isArray(row[k]) && row[k].length > 0 && typeof row[k][0] === "object" && row[k][0] !== null
    );
    if (!nestedKey) { out.push(row); continue; }
    const { [nestedKey]: children, ...parent } = row;
    for (const child of children) {
      out.push({ ...parent, ...flatten(child, nestedKey.replace(/s$/, "")) });
      if (out.length >= 50_000) return out;
    }
  }
  return out;
}

export async function fetchFeedItems(config, { fetchImpl = safeFetch } = {}) {
  const headers = config.authHeader?.name ? { [config.authHeader.name]: config.authHeader.value } : {};
  const res = await fetchImpl(config.url, { headers, maxBytes: 20 * 1024 * 1024 });
  if (res.status !== 200) {
    const err = new Error(`feed returned HTTP ${res.status}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  const ct = (typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
  const body = res.text.trim();
  const format = config.format && config.format !== "auto" ? config.format
    : ct.includes("json") ? "json" : ct.includes("xml") ? "xml" : ct.includes("csv") ? "csv"
    : body.startsWith("{") || body.startsWith("[") ? "json"
    : body.startsWith("<") ? "xml" : "csv";
  let rows;
  if (format === "json") rows = findArray(JSON.parse(body));
  else if (format === "xml") rows = findArray(new XMLParser({ ignoreAttributes: false }).parse(body));
  else rows = parseCsvItems(body).rows;
  if (!rows || !rows.length) { const e = new Error("no rows found in feed"); e.permanent = true; throw e; }
  return { rows: explodeNested(rows).map((r) => flatten(r)) };
}
