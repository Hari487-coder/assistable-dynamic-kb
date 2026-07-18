import { editDistance } from "./normalize.js";

// Zero-results spell correction against the source's OWN vocabulary: the
// fts5vocab virtual table over the items index is a free, always-current term
// dictionary (stemmed, so it matches what FTS actually indexed). Fires only
// when a search found nothing - the blast radius is queries that were already
// dead ends. Voice/ASR errors are usually 1-2 edits in transcript space
// ("tocoma", "centra"), which is exactly what this catches.

export function correctTokens(db, tokens) {
  const corrected = [];
  const changes = [];
  for (const t of tokens) {
    if (t.length < 3 || /^\d+$/.test(t)) { corrected.push(t); continue; }
    const exact = db.prepare("SELECT term FROM items_fts_vocab WHERE term = ? LIMIT 1").get(t);
    if (exact) { corrected.push(t); continue; }
    // Same-first-letter + similar-length window bounds the scan; doc count
    // breaks ties toward the more common term.
    const candidates = db.prepare(
      `SELECT term, doc FROM items_fts_vocab
       WHERE term >= ? AND term < ? AND abs(length(term) - ?) <= 2
       ORDER BY doc DESC LIMIT 200`
    ).all(t[0], t[0] + "￿", t.length);
    let best = null, bestDist = 3;
    for (const c of candidates) {
      const d = editDistance(t, c.term);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    if (best && bestDist <= 2) { corrected.push(best.term); changes.push(`${t}→${best.term}`); }
    else corrected.push(t);
  }
  return { tokens: corrected, changes };
}
