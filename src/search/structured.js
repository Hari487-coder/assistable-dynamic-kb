import { resolveCategorical, tokensFor, expandToken } from "./normalize.js";
import { deriveIntent } from "./intent.js";
import { correctTokens } from "./spell.js";
import { parseNumericLike } from "../ingest/normalize.js";
import { paramName } from "../assistable/tool-def.js";
import { findGeoCols, haversineMiles } from "./geo.js";

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
  // Index by the real column name AND by the sanitized name the tool schema
  // advertises to the LLM ("Price per kg (£)" -> "Price_per_kg"), so filters
  // still resolve for spreadsheets with punctuation in their headers.
  const byName = {};
  for (const c of columns) {
    byName[c.name.toLowerCase()] = c;
    const advertised = paramName(c.name).toLowerCase();
    if (!(advertised in byName)) byName[advertised] = c;
  }
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

function filterWhere(source, filters) {
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
  return { whereSql: where.join(" AND "), baseParams: [source.id, source.active_batch_id, ...params] };
}

function runQuery(db, source, filters, query, sort = null) {
  const { whereSql, baseParams } = filterWhere(source, filters);
  const count = (extraSql = "", extraParams = []) =>
    db.prepare(`SELECT count(*) c FROM items i ${extraSql ? `JOIN items_fts ON items_fts.rowid = i.rowid` : ""}
                WHERE ${whereSql}${extraSql}`).get(...baseParams, ...extraParams).c;
  // COUNT only pays off when the page is full — a short page IS the total.
  const withTotal = (rows, extraSql = "", extraParams = []) =>
    ({ rows, total: rows.length < 5 ? rows.length : count(extraSql, extraParams) });

  // Explicit sort intent ("cheapest", "newest") outranks relevance ordering.
  // Rows missing the sort value are excluded: SQLite orders NULLs first on
  // ASC, so "cheapest" would lead with the items that have no price at all.
  if (sort) {
    const orderSql = `AND json_extract(i.structured_json, ?) IS NOT NULL
      ORDER BY CAST(json_extract(i.structured_json, ?) AS REAL) ${sort.dir === "desc" ? "DESC" : "ASC"} LIMIT 5`;
    const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ${orderSql}`)
      .all(...baseParams, `$.${sort.col}`, `$.${sort.col}`);
    return withTotal(rows);
  }

  // Stem-exact terms (porter covers plurals), never prefix wildcards — prefix
  // scans over a large term dictionary were measured at 100-800ms on 5k rows.
  // Two-stage: (1) relevance candidates from the FTS index alone — no JSON
  // evaluation; (2) filters applied to at most 500 candidate rowids. Evaluating
  // json_extract per FTS match was the remaining measured hotspot (~110ms CPU).
  // The 500-candidate cap is per-instance-single-business safe (self-hosted).
  let ignoredWords = null;
  const tokens = tokensFor(query);
  if (tokens.length) {
    const attempt = (toks) => {
      // Concept = the token OR its synonyms (parity with the text engine).
      const concepts = toks.map((t) => {
        const g = expandToken(t).map((w) => `"${w}"`);
        return g.length > 1 ? `(${g.join(" OR ")})` : g[0];
      });
      for (const match of [concepts.join(" AND "), concepts.join(" OR ")]) {
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
      return null;
    };
    let found = attempt(tokens);
    if (!found) {
      // Dead end: spell-correct against this source's own indexed vocabulary
      // and retry once (catches ASR near-misses like "tocoma").
      const fixed = correctTokens(db, tokens);
      if (fixed.changes.length) {
        found = attempt(fixed.tokens);
        if (found) found.spellChanges = fixed.changes;
      }
    }
    if (found) return found;
    // Words matched nothing. With no filters to fall back on this is a true
    // dead end - return empty so the ladder labels it honestly. Returning the
    // unfiltered set here would hand back arbitrary rows as "exact matches"
    // ("do you have a submarine?" -> "Yes, a 2022 Tacoma"). Never do that.
    if (!filters.length) return { rows: [], total: 0 };
    // With filters present, the unmatched words were conversational noise
    // ("any cheap cars") - the filters still answer, and we say what we dropped.
    ignoredWords = tokens;
  }
  // Filter-only (or noise-only) query: the filtered set IS the answer.
  // Stable rowid ordering keeps identical calls identical.
  const rows = db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ORDER BY i.rowid LIMIT 5`).all(...baseParams);
  return { ...withTotal(rows), ignoredWords };
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

  // The location the caller named couldn't be resolved: search runs without
  // the distance leg, and the answer says so instead of silently ignoring it.
  if (args._geoFail) relaxations.push(`couldn't locate "${args._geoFail}" - searched without distance`);

  // Distance leg: rows carry lat/lng and the caller's location is resolved.
  // Runs in JS over the filtered candidate set (bounded) because "distance
  // from HERE" is per-query - it can't live in an index.
  const geoCols = args._geo ? findGeoCols(columns) : null;
  if (geoCols) {
    const point = args._geo;
    const radius = Math.min(500, Math.max(1, Number(point.radiusMiles) || 25));
    const { whereSql, baseParams } = filterWhere(source, active);
    const candidates = wrap(db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ORDER BY i.rowid LIMIT 2000`).all(...baseParams));
    const placed = candidates.flatMap((r) => {
      const la = r.structured[geoCols.lat], ln = r.structured[geoCols.lng];
      return typeof la === "number" && typeof ln === "number"
        ? [{ ...r, d: haversineMiles(point.lat, point.lng, la, ln) }] : [];
    });
    // "Who pays the most near X" sorts by the asked column (rows missing it
    // excluded, as in the main sort path); otherwise nearest-first.
    let inRange = placed.filter((r) => r.d <= radius);
    if (intent.sort) {
      inRange = inRange.filter((r) => r.structured[intent.sort.col] !== null && r.structured[intent.sort.col] !== undefined);
      const dir = intent.sort.dir === "desc" ? -1 : 1;
      inRange.sort((a, b) => dir * (a.structured[intent.sort.col] - b.structured[intent.sort.col]) || a.d - b.d);
      relaxations.push(`sorted by ${intent.sort.col} ${intent.sort.dir === "desc" ? "high to low" : "low to high"}`);
    } else {
      inRange.sort((a, b) => a.d - b.d);
    }
    const decorate = (r) => ({ ...r, structured: { distance_miles: Math.round(r.d * 10) / 10, ...r.structured } });
    const geoFilters = { ...appliedFilters, near: point.label ?? "your location", radius_miles: radius };
    if (inRange.length) {
      relaxations.push(`within ${radius} miles of ${point.label ?? "your location"}`);
      return { items: inRange.slice(0, 5).map(decorate), resultCount: inRange.length, appliedFilters: geoFilters, relaxations, alternatives: [] };
    }
    placed.sort((a, b) => a.d - b.d);
    relaxations.push(`nothing within ${radius} miles of ${point.label ?? "your location"}; nearest options shown`);
    return { items: [], resultCount: 0, appliedFilters: geoFilters, relaxations, alternatives: placed.slice(0, 3).map(decorate) };
  }

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
    if (res.spellChanges) relaxations.push(`corrected spelling: ${res.spellChanges.join(", ")}`);
    // Only report words the owner would agree are unknown. A word that names
    // one of their columns ("price", "grade") is structural, not missing -
    // reporting `ignored "price" (not found in your data)` next to a price
    // column reads like a bug in the log.
    const columnWords = new Set(columns.flatMap((c) => tokensFor(String(c.name).replace(/_/g, " "))));
    const unknown = (res.ignoredWords ?? []).filter((w) => !columnWords.has(w));
    if (unknown.length) relaxations.push(`ignored "${unknown.join(" ")}" (not found in your data)`);
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
