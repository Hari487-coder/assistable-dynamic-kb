import { resolveCategorical } from "./normalize.js";

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

function runQuery(db, source, filters, query) {
  const where = ["i.source_id = ?", "i.batch_id = ?"];
  const params = [source.id, source.active_batch_id];
  for (const f of filters) {
    // JSON path is BOUND, never interpolated - column names are tenant data.
    const path = "json_extract(i.structured_json, ?)";
    const pathArg = `$.${f.col}`;
    if (f.op === "min") { where.push(`CAST(${path} AS REAL) >= ?`); params.push(pathArg, f.value); }
    else if (f.op === "max") { where.push(`CAST(${path} AS REAL) <= ?`); params.push(pathArg, f.value); }
    else if (f.op === "eq") { where.push(`CAST(${path} AS REAL) = ?`); params.push(pathArg, f.value); }
    else { where.push(`${path} = ?`); params.push(pathArg, f.resolved ?? f.value); }
  }
  const tokens = String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  if (tokens.length) {
    const match = tokens.map((t) => `"${t}"*`).join(" OR ");
    const sql = `SELECT i.*, bm25(items_fts) AS rank FROM items i JOIN items_fts ON items_fts.rowid = i.rowid
                 WHERE ${where.join(" AND ")} AND items_fts MATCH ? ORDER BY rank LIMIT 5`;
    const withFts = db.prepare(sql).all(...params, match);
    if (withFts.length) return withFts;
  }
  return db.prepare(`SELECT i.* FROM items i WHERE ${where.join(" AND ")} LIMIT 5`).all(...params);
}

export function searchStructured(db, source, args = {}) {
  const columns = JSON.parse(source.column_meta_json || "[]");
  const filters = extractFilters(args, columns);
  const relaxations = [];
  const appliedFilters = {};

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
  let rows = runQuery(db, source, active, args.query);
  if (rows.length) return { items: wrap(rows), resultCount: rows.length, appliedFilters, relaxations, alternatives: [] };

  // Tier 2: widen numeric bounds +-15%
  const widened = active.map((f) =>
    f.op === "max" ? { ...f, value: Math.round(f.value * 1.15) } :
    f.op === "min" ? { ...f, value: Math.round(f.value * 0.85) } : f
  );
  rows = runQuery(db, source, widened, args.query);
  if (rows.length) {
    for (const f of widened) if (["min", "max"].includes(f.op)) relaxations.push(`widened ${f.col}_${f.op} to ${f.value}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(rows) };
  }

  // Tier 3: drop the filter whose removal yields the most results
  let best = { rows: [], dropped: null };
  for (let i = 0; i < active.length; i++) {
    const subset = active.filter((_, j) => j !== i);
    const r = runQuery(db, source, subset, args.query);
    if (r.length > best.rows.length) best = { rows: r, dropped: active[i] };
  }
  if (best.rows.length) {
    relaxations.push(`no exact match; closest ignoring ${best.dropped.col}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(best.rows.slice(0, 3)) };
  }

  // Tier 4: query-only FTS
  rows = runQuery(db, source, [], args.query);
  if (rows.length) relaxations.push("no filter match; keyword-only results");
  return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(rows.slice(0, 3)) };
}
