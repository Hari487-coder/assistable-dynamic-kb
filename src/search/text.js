export function searchText(db, source, query) {
  const tokens = String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  if (!tokens.length) return { items: [], resultCount: 0 };
  // Precision first: require ALL tokens, fall back to ANY. Title weighted 2x.
  const run = (match) => db.prepare(
    `SELECT i.title, i.body, bm25(items_fts, 2.0, 1.0) AS rank FROM items i
     JOIN items_fts ON items_fts.rowid = i.rowid
     WHERE i.source_id = ? AND i.batch_id = ? AND items_fts MATCH ?
     ORDER BY rank LIMIT 5`
  ).all(source.id, source.active_batch_id, match);
  const quoted = tokens.map((t) => `"${t}"*`);
  let rows = run(quoted.join(" AND "));
  if (!rows.length) rows = run(quoted.join(" OR "));
  return {
    items: rows.map((r) => ({ title: r.title, snippet: r.body.slice(0, 300) })),
    resultCount: rows.length,
  };
}
