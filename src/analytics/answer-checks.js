// Answer checks: does the assistant still answer the questions people actually
// ask?
//
// The honest constraint shapes this whole file. The data is LIVE - prices and
// stock move every sync, by design. So a check that asserted "cheapest copper
// is £7.20" would fail every single day and be ignored within a week. Values
// cannot be the assertion.
//
// What CAN be asserted is answerability: a question that a real caller asked,
// and that we answered, must keep getting an answer. That signal is independent
// of the data churning underneath it, and it catches the failures that actually
// break a customer: a sync that silently dropped a column, a feed that changed
// shape, a filter that stopped matching.
//
// Correctness of a value can only come from the person who owns the data, so
// that arrives the other way: the owner marks an answer wrong, and it becomes a
// tracked issue rather than a metric.

import crypto from "node:crypto";
import { answerQuery } from "../search/answer.js";

const MAX_CHECKS_PER_SOURCE = 40;
const MINE_WINDOW_DAYS = 30;
const MIN_QUERY_LEN = 3;

export const normalizeQuery = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * What we remember about an answer. `numbers` and `top` are recorded so a
 * change can be DESCRIBED to the owner ("price moved 7.20 -> 7.60"), not so it
 * can be failed on.
 */
export function answerFingerprint(out) {
  const items = Array.isArray(out?.items) ? out.items : [];
  return {
    ok: out?.ok !== false,
    resultCount: out?.result_count ?? 0,
    top: items.slice(0, 3).map((i) => String(i?.title ?? "")).filter(Boolean),
    numbers: items[0]
      ? Object.fromEntries(Object.entries(items[0]).filter(([, v]) => typeof v === "number"))
      : {},
  };
}

/**
 * baseline vs current -> {status, detail}.
 *   pass      - still answering the same thing
 *   changed   - still answering, but the data moved (informational, expected)
 *   regressed - stopped answering, or errored. This is the one that matters.
 */
export function compareAnswer(baseline, current) {
  if (!current.ok) {
    return { status: "regressed", detail: "The tool errored on a question it used to answer." };
  }
  if (current.resultCount === 0) {
    return baseline.resultCount > 0
      ? { status: "regressed", detail: `Used to return ${baseline.resultCount} match${baseline.resultCount === 1 ? "" : "es"}, now returns nothing.` }
      : { status: "regressed", detail: "Returns nothing." };
  }
  const was = baseline.top[0] ?? "";
  const now = current.top[0] ?? "";
  if (was && now && was !== now) {
    return { status: "changed", detail: `Top answer moved from "${was}" to "${now}".` };
  }
  const moved = Object.entries(current.numbers)
    .filter(([k, v]) => k in baseline.numbers && baseline.numbers[k] !== v)
    .map(([k, v]) => `${k} ${baseline.numbers[k]} -> ${v}`);
  if (moved.length) return { status: "changed", detail: `${moved.slice(0, 3).join(", ")}.` };
  return { status: "pass", detail: "" };
}

/**
 * Promote the questions callers actually ask into checks. Mined from the call
 * log rather than captured on the hot path, so a live voice call never pays for
 * this, and frequency ranking picks the questions that matter most.
 */
export function mineChecks(db, sourceId, { now = Date.now(), max = MAX_CHECKS_PER_SOURCE } = {}) {
  const since = new Date(now - MINE_WINDOW_DAYS * 864e5).toISOString();
  const existing = db.prepare("SELECT count(*) c FROM answer_checks WHERE source_id = ?").get(sourceId).c;
  if (existing >= max) return 0;
  const rows = db.prepare(
    `SELECT args_json, count(*) n, max(ts) last_ts
       FROM tool_calls
      WHERE source_id = ? AND ts >= ? AND outcome = 'answered' AND ok = 1
        AND json_extract(args_json, '$.query') IS NOT NULL
        AND length(trim(json_extract(args_json, '$.query'))) >= ?
      GROUP BY lower(trim(json_extract(args_json, '$.query')))
      ORDER BY n DESC, last_ts DESC
      LIMIT ?`
  ).all(sourceId, since, MIN_QUERY_LEN, max - existing);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO answer_checks (id, source_id, query, args_json, origin, status, created_at)
     VALUES (?,?,?,?,'auto','new',?)`
  );
  let added = 0;
  for (const r of rows) {
    let args;
    try { args = JSON.parse(r.args_json); } catch { continue; }
    const q = normalizeQuery(args.query);
    if (!q) continue;
    added += insert.run(crypto.randomUUID(), sourceId, q, JSON.stringify(args), new Date(now).toISOString()).changes;
  }
  return added;
}

/**
 * Replay every active check for a source against today's data.
 *
 * A regression keeps its original baseline so it stays visible until it's
 * genuinely fixed; re-baselining a failure would make the alarm vanish
 * overnight, which is the classic way a monitoring system lies to you.
 */
export function runAnswerChecks(db, sourceId, { now = Date.now(), logger = null } = {}) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
  const tally = { ran: 0, pass: 0, changed: 0, regressed: 0 };
  if (!source?.active_batch_id) return tally;

  const checks = db.prepare("SELECT * FROM answer_checks WHERE source_id = ? AND active = 1").all(sourceId);
  const save = db.prepare("UPDATE answer_checks SET status = ?, detail = ?, last_run_at = ?, baseline_json = ? WHERE id = ?");
  const ts = new Date(now).toISOString();

  for (const c of checks) {
    let out;
    try {
      out = answerQuery(db, source, JSON.parse(c.args_json));
    } catch (err) {
      logger?.error("answer check failed to run", { checkId: c.id, error: String(err?.message || err) });
      out = { ok: false };
    }
    const fresh = answerFingerprint(out);
    const baseline = c.baseline_json ? JSON.parse(c.baseline_json) : null;

    const { status, detail } = baseline
      ? compareAnswer(baseline, fresh)
      : (fresh.ok && fresh.resultCount > 0
        ? { status: "pass", detail: "" }
        : { status: "regressed", detail: "Did not answer when first checked." });

    // Keep the failing expectation; move it forward only while healthy.
    const nextBaseline = status === "regressed" ? (c.baseline_json ?? JSON.stringify(fresh)) : JSON.stringify(fresh);
    save.run(status, detail, ts, nextBaseline, c.id);
    tally.ran++;
    tally[status] = (tally[status] ?? 0) + 1;
  }
  return tally;
}

/** Mine + run for every synced source. The daily job. */
export function runDailyChecks(db, { now = Date.now(), logger = null } = {}) {
  const sources = db.prepare("SELECT id FROM sources WHERE active_batch_id IS NOT NULL").all();
  const total = { sources: 0, ran: 0, pass: 0, changed: 0, regressed: 0, added: 0 };
  for (const { id } of sources) {
    try {
      total.added += mineChecks(db, id, { now });
      const t = runAnswerChecks(db, id, { now, logger });
      total.sources++;
      for (const k of ["ran", "pass", "changed", "regressed"]) total[k] += t[k] ?? 0;
    } catch (err) {
      logger?.error("daily answer checks failed", { sourceId: id, error: String(err?.message || err) });
    }
  }
  if (total.ran) logger?.info("answer checks run", total);
  return total;
}

/** Owner-facing rollup for one source. */
export function checksSummary(db, sourceId) {
  const rows = db.prepare(
    "SELECT status, query, detail, last_run_at, flagged_at, flag_note FROM answer_checks WHERE source_id = ? AND active = 1"
  ).all(sourceId);
  const flagged = rows.filter((r) => r.flagged_at);
  const regressed = rows.filter((r) => r.status === "regressed" && !r.flagged_at);
  const changed = rows.filter((r) => r.status === "changed" && !r.flagged_at);
  return {
    total: rows.length,
    passing: rows.filter((r) => r.status === "pass").length,
    regressed, changed, flagged,
    lastRunAt: rows.map((r) => r.last_run_at).filter(Boolean).sort().pop() ?? null,
  };
}
