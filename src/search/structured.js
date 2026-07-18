import { resolveCategorical } from "./normalize.js";
import { deriveIntent } from "./intent.js";

const SENTINEL = (v) => v === "" || v === 0 || v === null || v === undefined;

function extractFilters(args, columns) {
  const byName = Object.fromEntries(columns.map((c) => [c.name.toLowerCase(), c]));
  const raw = { ...(typeof args.filters === "object" && args.filters ? args.filters : {}) };
  for (const [k, v] of Object.entries(args)) {
    if (["query", "filters"].includes(k)) continue;
    raw[k] = raw[k] ?? v;
  }
  const filters = [];
  for (const [key, value] of Object.entries(raw)) {
    if (SENTINEL(value)) continue;
    const m = key.toLowerCase().match(/^(.*)_(min|max)$/);
    if (m && byName[m[1]]?.kind === "numeric") {
      filters.push({ col: byName[m[1]].name, op: m[2], value: Number(value) });
    } else if (byName[key.toLowerCase()]) {
      const col = byName[key.toLowerCase()];
      if (col.kind === "numeric") filters.push({ col: col.name, op: "eq", value: Number(value) });
      else filters.push({ col: col.name, op: "cat", value: String(value), distincts: col.distincts || [] });
    }
  }
  return filters;
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

  // Explicit sort intent ("cheapest", "newest") outranks relevance ordering.
  if (sort) {
    const orderSql = `ORDER BY CAST(json_extract(i.structured_json, ?) AS REAL) ${sort.dir === "desc" ? "DESC" : "ASC"} LIMIT 5`;
    const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ${orderSql}`).all(...baseParams, `$.${sort.col}`);
    return { rows, total: count() };
  }

  const tokens = String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  if (tokens.length) {
    // Precision first: require ALL tokens, fall back to ANY. Title weighted 2x.
    const ftsSql = (match) => db.prepare(
      `SELECT i.*, bm25(items_fts, 2.0, 1.0) AS rank FROM items i JOIN items_fts ON items_fts.rowid = i.rowid
       WHERE ${whereSql} AND items_fts MATCH ? ORDER BY rank LIMIT 5`).all(...baseParams, match);
    const quoted = tokens.map((t) => `"${t}"*`);
    for (const match of [quoted.join(" AND "), quoted.join(" OR ")]) {
      const rows = ftsSql(match);
      if (rows.length) return { rows, total: count(" AND items_fts MATCH ?", [match]) };
    }
  }
  const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} LIMIT 5`).all(...baseParams);
  return { rows, total: count() };
}

export function searchStructured(db, source, args = {}) {
  const columns = JSON.parse(source.column_meta_json || "[]");
  const filters = extractFilters(args, columns);
  const relaxations = [];
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
  let res = runQuery(db, source, active, args.query, intent.sort);
  if (res.rows.length) {
    if (intent.sort) relaxations.push(`sorted by ${intent.sort.col} ${intent.sort.dir === "desc" ? "high to low" : "low to high"}`);
    return { items: wrap(res.rows), resultCount: res.total, appliedFilters, relaxations, alternatives: [] };
  }

  // Tier 2: widen numeric bounds +-15%
  const widened = active.map((f) =>
    f.op === "max" ? { ...f, value: Math.round(f.value * 1.15) } :
    f.op === "min" ? { ...f, value: Math.round(f.value * 0.85) } : f
  );
  res = runQuery(db, source, widened, args.query, intent.sort);
  if (res.rows.length) {
    for (const f of widened) if (["min", "max"].includes(f.op)) relaxations.push(`widened ${f.col}_${f.op} to ${f.value}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(res.rows) };
  }

  // Tier 3: drop the filter whose removal yields the most results
  let best = { rows: [], dropped: null };
  for (let i = 0; i < active.length; i++) {
    const subset = active.filter((_, j) => j !== i);
    const r = runQuery(db, source, subset, args.query, intent.sort);
    if (r.rows.length > best.rows.length) best = { rows: r.rows, dropped: active[i] };
  }
  if (best.rows.length) {
    relaxations.push(`no exact match; closest ignoring ${best.dropped.col}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(best.rows.slice(0, 3)) };
  }

  // Tier 4: query-only FTS
  res = runQuery(db, source, [], args.query, null);
  if (res.rows.length) relaxations.push("no filter match; keyword-only results");
  return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(res.rows.slice(0, 3)) };
}
