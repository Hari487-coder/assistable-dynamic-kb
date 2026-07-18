import { tokensFor } from "./normalize.js";

export function searchText(db, source, query) {
  const tokens = tokensFor(query);
  if (!tokens.length) return { items: [], resultCount: 0 };
  // Precision first: ALL stemmed terms, fall back to ANY. Title weighted 2x.
  // Stem-exact (no prefix wildcards) - porter covers plural/verb variants and
  // prefix scans were the measured latency outlier at scale.
  const run = (match) => db.prepare(
    `SELECT i.title, i.body, bm25(items_fts, 2.0, 1.0) AS rank FROM items i
     JOIN items_fts ON items_fts.rowid = i.rowid
     WHERE i.source_id = ? AND i.batch_id = ? AND items_fts MATCH ?
     ORDER BY rank LIMIT 5`
  ).all(source.id, source.active_batch_id, match);
  const quoted = tokens.map((t) => `"${t}"`);
  let rows = run(quoted.join(" AND "));
  if (!rows.length) rows = run(quoted.join(" OR "));
  return {
    items: rows.map((r) => ({ title: r.title, snippet: r.body.slice(0, 300) })),
    resultCount: rows.length,
  };
}
