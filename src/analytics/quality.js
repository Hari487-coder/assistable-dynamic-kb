// Retrieval quality telemetry. Two jobs:
//  1. Show the owner, in plain language, how well their assistant is answering.
//  2. Produce the decision-grade number for the deferred semantic-fallback
//     question: how many real questions found NOTHING that keyword search
//     could rescue. Build the expensive thing only if this number is real.

/** Classify a tool response into one outcome bucket. Pure - safe to unit test. */
export function classifyOutcome(out) {
  if (!out?.ok) return out?.error === "not_synced" ? "not_synced" : "error";
  if (out.browse) return "browse";
  if ((out.result_count ?? 0) > 0) return out.answerable === false ? "weak" : "answered";
  if (out.close_alternatives?.length) return "alternatives";
  return "no_match";
}

/** Notable things that happened while answering, for the owner-facing report. */
export function callFlags(out) {
  const rx = (out?.relaxations ?? []).join(" | ");
  const flags = [];
  if (/corrected spelling/.test(rx)) flags.push("spell");
  if (/based on your data/.test(rx)) flags.push("qualitative");
  if (/carried from earlier/.test(rx)) flags.push("context");
  if (/widened|closest ignoring|keyword-only/.test(rx)) flags.push("relaxed");
  if (out?.cached) flags.push("cached");
  if (out?.data_freshness === "stale") flags.push("stale_data");
  return flags.join(",");
}

const PCT = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/**
 * qualitySummary(db, {sourceId, days}) -> owner-facing retrieval report.
 * sourceId omitted = whole instance.
 */
export function qualitySummary(db, { sourceId = null, days = 7 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const where = sourceId ? "ts >= ? AND source_id = ?" : "ts >= ?";
  const params = sourceId ? [since, sourceId] : [since];

  const rows = db.prepare(
    `SELECT outcome, flags, took_ms FROM tool_calls WHERE ${where}`).all(...params);
  const total = rows.length;
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const flagged = (f) => rows.filter((r) => (r.flags || "").split(",").includes(f)).length;

  const times = rows.map((r) => r.took_ms ?? 0).sort((a, b) => a - b);
  const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : 0);

  const answered = count("answered");
  const alternatives = count("alternatives");
  const noMatch = count("no_match");

  const unanswered = db.prepare(
    `SELECT args_json, count(*) n, max(ts) last_ts FROM tool_calls
     WHERE ${where} AND outcome IN ('no_match','weak')
     GROUP BY args_json ORDER BY n DESC, last_ts DESC LIMIT 10`).all(...params)
    .map((r) => {
      let query = r.args_json;
      try { query = JSON.parse(r.args_json).query || r.args_json; } catch { /* raw */ }
      return { query: String(query).slice(0, 140), n: r.n, lastTs: r.last_ts };
    });

  return {
    days, total,
    answered, alternatives, noMatch,
    weak: count("weak"), browse: count("browse"), errors: count("error") + count("not_synced"),
    // "Helped" = the caller got something usable: a match OR a labeled near-miss.
    helpedPct: PCT(answered + alternatives, total),
    answeredPct: PCT(answered, total),
    // The semantic-fallback decision number: nothing found, nothing to offer.
    deadEndPct: PCT(noMatch, total),
    p50: pct(0.5), p95: pct(0.95),
    spell: flagged("spell"), qualitative: flagged("qualitative"),
    context: flagged("context"), relaxed: flagged("relaxed"), cached: flagged("cached"),
    unanswered,
  };
}
