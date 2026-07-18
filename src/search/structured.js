import { resolveCategorical, tokensFor } from "./normalize.js";
import { deriveIntent } from "./intent.js";
import { parseNumericLike } from "../ingest/normalize.js";

const SENTINEL = (v) => v === "" || v === 0 || v === null || v === undefined;

// LLMs eventually send every malformed shape: arrays, nested objects, "$30k",
// NaN-producing strings, 10kb queries. Normalize instead of erroring - a tool
// call must never fail because the model was sloppy.
function coerceScalar(v) {
  if (Array.isArray(v)) v = v[0];
  if (v !== null && typeof v === "object") return undefined;
  return v;
}

function coerceNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseNumericLike(String(v));
  return n === null || !Number.isFinite(n) ? null : n;
}

function extractFilters(args, columns) {
  const byName = Object.fromEntries(columns.map((c) => [c.name.toLowerCase(), c]));
  const raw = { ...(typeof args.filters === "object" && args.filters && !Array.isArray(args.filters) ? args.filters : {}) };
  for (const [k, v] of Object.entries(args)) {
    if (["query", "filters"].includes(k)) continue;
    raw[k] = raw[k] ?? v;
  }
  const filters = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    const value = coerceScalar(rawValue);
    if (SENTINEL(value)) continue;
    const m = key.toLowerCase().match(/^(.*)_(min|max)$/);
    if (m && byName[m[1]]?.kind === "numeric") {
      const n = coerceNumber(value);
      if (n !== null) filters.push({ col: byName[m[1]].name, op: m[2], value: n });
    } else if (byName[key.toLowerCase()]) {
      const col = byName[key.toLowerCase()];
      if (col.kind === "numeric") {
        const n = coerceNumber(value);
        if (n !== null) filters.push({ col: col.name, op: "eq", value: n });
      } else {
        filters.push({ col: col.name, op: "cat", value: String(value).slice(0, 200), distincts: col.distincts || [] });
      }
    }
  }
  // An impossible min>max pair (e.g. "over 30k under 20k") would silently
  // return nothing; drop the pair and let relaxation-free search proceed.
  const dropped = new Set();
  for (const f of filters) {
    if (f.op !== "min") continue;
    const twin = filters.find((g) => g.col === f.col && g.op === "max");
    if (twin && f.value > twin.value) { dropped.add(f); dropped.add(twin); }
  }
  const kept = filters.filter((f) => !dropped.has(f));
  kept.conflictNote = dropped.size ? `ignored impossible range on ${[...dropped][0].col} (min above max)` : null;
  return kept;
}

function runQuery(db, source, filters, query, sort = null) {
  const where = ["i.source_id = ?", "i.batch_id = ?"];
  const params = [];
  for (const f of filters) {
    // JSON path is BOUND, never interpolated - column names are tenant data.
    const path = "json_extract(i.structured_json, ?)";
    const pathArg = `$.${f.col}`;
    if (f.op === "min") { where.push(`CAST(${path} AS REAL) >= ?`); params.push(pathArg, f.value); }
    else if (f.op === "max") { where.push(`CAST(${path} AS REAL) <= ?`); params.push(pathArg, f.value); }
    else if (f.op === "eq") { where.push(`CAST(${path} AS REAL) = ?`); params.push(pathArg, f.value); }
    else { where.push(`${path} = ?`); params.push(pathArg, f.resolved ?? f.value); }
  }
  const whereSql = where.join(" AND ");
  const baseParams = [source.id, source.active_batch_id, ...params];
  const count = (extraSql = "", extraParams = []) =>
    db.prepare(`SELECT count(*) c FROM items i ${extraSql ? `JOIN items_fts ON items_fts.rowid = i.rowid` : ""}
                WHERE ${whereSql}${extraSql}`).get(...baseParams, ...extraParams).c;
  // COUNT only pays off when the page is full — a short page IS the total.
  const withTotal = (rows, extraSql = "", extraParams = []) =>
    ({ rows, total: rows.length < 5 ? rows.length : count(extraSql, extraParams) });

  // Explicit sort intent ("cheapest", "newest") outranks relevance ordering.
  if (sort) {
    const orderSql = `ORDER BY CAST(json_extract(i.structured_json, ?) AS REAL) ${sort.dir === "desc" ? "DESC" : "ASC"} LIMIT 5`;
    const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ${orderSql}`).all(...baseParams, `$.${sort.col}`);
    return withTotal(rows);
  }

  // Stem-exact terms (porter covers plurals), never prefix wildcards — prefix
  // scans over a large term dictionary were measured at 100-800ms on 5k rows.
  // Two-stage: (1) relevance candidates from the FTS index alone — no JSON
  // evaluation; (2) filters applied to at most 500 candidate rowids. Evaluating
  // json_extract per FTS match was the remaining measured hotspot (~110ms CPU).
  // The 500-candidate cap is per-instance-single-business safe (self-hosted).
  const tokens = tokensFor(query);
  if (tokens.length) {
    const quoted = tokens.map((t) => `"${t}"`);
    for (const match of [quoted.join(" AND "), quoted.join(" OR ")]) {
      const cand = db.prepare(
        `SELECT rowid AS rid, bm25(items_fts, 2.0, 1.0) AS rank FROM items_fts
         WHERE items_fts MATCH ? ORDER BY rank LIMIT 500`).all(match);
      if (!cand.length) continue;
      const rankByRid = new Map(cand.map((c) => [c.rid, c.rank]));
      const rows = db.prepare(
        `SELECT i.*, i.rowid AS rid FROM items i
         WHERE ${whereSql} AND i.rowid IN (${cand.map(() => "?").join(",")})`)
        .all(...baseParams, ...cand.map((c) => c.rid))
        .sort((a, b) => rankByRid.get(a.rid) - rankByRid.get(b.rid));
      if (rows.length) return { rows: rows.slice(0, 5), total: rows.length };
    }
  }
  // Stable rowid ordering: identical calls return identical rows (caching,
  // retries, and screenshots all depend on determinism).
  const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ORDER BY i.rowid LIMIT 5`).all(...baseParams);
  return withTotal(rows);
}

export function searchStructured(db, source, args = {}) {
  // Corrupt column metadata must degrade to keyword search, not a dead tool.
  let columns = [];
  try { columns = JSON.parse(source.column_meta_json || "[]"); } catch { columns = []; }
  if (!Array.isArray(columns)) columns = [];
  args = { ...args, query: String(args.query ?? "").slice(0, 400) };
  const filters = extractFilters(args, columns);
  const relaxations = [];
  if (filters.conflictNote) relaxations.push(filters.conflictNote);
  const appliedFilters = {};

  // Query-understanding safety net: recover bounds/year/sort the LLM did not
  // extract as typed args. Never overrides an explicitly-passed filter.
  const intent = deriveIntent(args.query, columns);
  for (const derived of intent.filters) {
    if (filters.some((f) => f.col === derived.col)) continue;
    filters.push(derived);
    relaxations.push(derived.note);
  }

  for (const f of filters.filter((f) => f.op === "cat")) {
    const res = resolveCategorical(f.value, f.distincts);
    if (res.value) {
      f.resolved = res.value;
      if (res.method === "alias" || res.method === "fuzzy") relaxations.push(`interpreted ${f.col} "${f.value}" as "${res.value}"`);
    } else {
      relaxations.push(`ignored unrecognized ${f.col} "${f.value}"`);
      f.skip = true;
    }
  }
  const active = filters.filter((f) => !f.skip);
  for (const f of active) appliedFilters[f.op === "cat" ? f.col : `${f.col}_${f.op}`] = f.resolved ?? f.value;

  const wrap = (rows) => rows.map((r) => ({ ...r, structured: JSON.parse(r.structured_json) }));
  const ftsQuery = intent.cleanedQuery;

  // Browse mode: the LLM sent nothing usable ("what do you have?"). Instead of
  // five arbitrary rows presented as "matches", return the catalog size plus
  // an invitation listing what CAN be asked - turning a junk call into a
  // conversation the agent can steer.
  if (!active.length && !tokensFor(ftsQuery).length && !intent.sort) {
    const res = runQuery(db, source, [], "", null);
    return {
      items: wrap(res.rows), resultCount: res.total, appliedFilters: {}, relaxations: [],
      alternatives: [], browse: true,
      browseColumns: columns.filter((c) => c.kind !== "text").map((c) => c.name).slice(0, 4),
    };
  }

  let res = runQuery(db, source, active, ftsQuery, intent.sort);
  if (res.rows.length) {
    if (intent.sort) relaxations.push(`sorted by ${intent.sort.col} ${intent.sort.dir === "desc" ? "high to low" : "low to high"}`);
    return { items: wrap(res.rows), resultCount: res.total, appliedFilters, relaxations, alternatives: [] };
  }

  // Tier 2: widen numeric bounds +-15%
  const widened = active.map((f) =>
    f.op === "max" ? { ...f, value: Math.round(f.value * 1.15) } :
    f.op === "min" ? { ...f, value: Math.round(f.value * 0.85) } : f
  );
  res = runQuery(db, source, widened, ftsQuery, intent.sort);
  if (res.rows.length) {
    for (const f of widened) if (["min", "max"].includes(f.op)) relaxations.push(`widened ${f.col}_${f.op} to ${f.value}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(res.rows) };
  }

  // Tier 3: drop the filter whose removal yields the most results
  let best = { rows: [], dropped: null };
  for (let i = 0; i < active.length; i++) {
    const subset = active.filter((_, j) => j !== i);
    const r = runQuery(db, source, subset, ftsQuery, intent.sort);
    if (r.rows.length > best.rows.length) best = { rows: r.rows, dropped: active[i] };
  }
  if (best.rows.length) {
    relaxations.push(`no exact match; closest ignoring ${best.dropped.col}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(best.rows.slice(0, 3)) };
  }

  // Tier 4: query-only FTS
  res = runQuery(db, source, [], ftsQuery, null);
  if (res.rows.length) relaxations.push("no filter match; keyword-only results");
  return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(res.rows.slice(0, 3)) };
}
