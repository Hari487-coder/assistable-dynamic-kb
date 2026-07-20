import { tokensFor, expandToken } from "./normalize.js";
import { correctTokens } from "./spell.js";

export function searchText(db, source, query) {
  let tokens = tokensFor(query);
  if (!tokens.length) return { items: [], resultCount: 0, matchQuality: "none" };
  // Precision first: ALL concepts must match (each concept = the token OR its
  // synonyms), fall back to ANY. Title weighted 2x. Stem-exact, no prefix
  // wildcards (measured latency outlier at scale).
  // snippet() returns the window AROUND the match (body is fts column 1), so
  // the agent gets the sentence that actually answers the question. Returning
  // body.slice(0,300) was a correctness bug: it handed back the top of a
  // 1500-char chunk, which frequently did not contain the matched text at all.
  const run = (match) => db.prepare(
    `SELECT i.title, i.body, snippet(items_fts, 1, '', '', ' … ', 26) AS snip,
            bm25(items_fts, 2.0, 1.0) AS rank
     FROM items i JOIN items_fts ON items_fts.rowid = i.rowid
     WHERE i.source_id = ? AND i.batch_id = ? AND items_fts MATCH ?
     ORDER BY rank LIMIT 5`
  ).all(source.id, source.active_batch_id, match);
  const conceptsFor = (toks) => toks.map((t) => {
    const group = expandToken(t).map((w) => `"${w}"`);
    return group.length > 1 ? `(${group.join(" OR ")})` : group[0];
  });
  let matchQuality = "strong";
  let spellChanges = [];
  let concepts = conceptsFor(tokens);
  let rows = run(concepts.join(" AND "));
  if (!rows.length) {
    // Dead end: try the source's own vocabulary for a spelling fix first.
    const fixed = correctTokens(db, tokens);
    if (fixed.changes.length) {
      concepts = conceptsFor(fixed.tokens);
      rows = run(concepts.join(" AND "));
      if (rows.length) spellChanges = fixed.changes;
    }
  }
  if (!rows.length) {
    matchQuality = "weak";
    rows = run(concepts.join(" OR "));
  }
  return {
    // Prefer the match window; fall back to the body head only if the match was
    // title-only (snippet of the body column comes back empty).
    items: rows.map((r) => ({
      title: r.title,
      snippet: (r.snip && r.snip.trim() ? r.snip.trim() : r.body.slice(0, 300)),
    })),
    resultCount: rows.length,
    matchQuality: rows.length ? matchQuality : "none",
    ...(spellChanges.length ? { spellChanges } : {}),
  };
}
