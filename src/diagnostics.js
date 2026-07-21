// A diagnostic bundle the owner can send to whoever supports them.
//
// Every instance is self-hosted: nobody can reach into someone else's box, and
// the setup page promises exactly that. So support works the honest way round -
// the owner exports a redacted picture of their instance and chooses to share
// it.
//
// SECURITY: this is an ALLOWLIST, never a denylist. Every field that leaves the
// instance is named explicitly below. A future column added to the schema is
// therefore excluded by default rather than silently exported, which is the
// only way this stays safe as the app grows. `test/diagnostics.test.js` seeds
// real secrets into every table and asserts none of them appear in the output.

import { qualitySummary } from "./analytics/quality.js";
import { checksSummary } from "./analytics/answer-checks.js";

export const BUNDLE_VERSION = 1;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Phone-shaped runs and long digit strings only. Short numbers are LEFT ALONE
// on purpose: "under 30k", "2022 tacoma", "£7.20" are the whole point of the
// question and scrubbing them would destroy the thing being debugged.
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const LONG_DIGITS_RE = /\b\d{7,}\b/g;

/** Light PII scrub for free text a customer typed or said. */
export function scrubText(s) {
  return String(s ?? "")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(LONG_DIGITS_RE, "[number]");
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Column structure, never column contents unless data sharing is opted into. */
function columnFacts(meta, includeData) {
  return meta.map((c) => ({
    name: c.name,
    kind: c.kind,
    ...(c.currency ? { currency: c.currency } : {}),
    ...(c.identityish ? { identityish: true } : {}),
    ...(c.kind === "numeric" ? { min: num(c.min), max: num(c.max), p25: num(c.p25), p75: num(c.p75) } : {}),
    ...(c.kind === "categorical"
      ? { distinctCount: c.distincts?.length ?? 0, ...(includeData ? { sampleValues: (c.distincts ?? []).slice(0, 8) } : {}) }
      : {}),
  }));
}

/**
 * @param {object} opts
 *  includeQuestions - the questions callers asked (scrubbed). Default true:
 *    without them retrieval quality cannot be diagnosed at all.
 *  includeData - sample rows and categorical values. Default false: that is
 *    the owner's business data, not diagnostics.
 */
export function buildDiagnosticBundle(db, config, { includeQuestions = true, includeData = false, now = Date.now(), appVersion = null } = {}) {
  const sources = db.prepare(
    "SELECT id, type, name, status, schedule_minutes, active_batch_id, column_meta_json, last_sync_at, next_run_at, consecutive_failures, created_at FROM sources"
  ).all();

  const bundle = {
    bundle: "live-kb-diagnostics",
    bundleVersion: BUNDLE_VERSION,
    generatedAt: new Date(now).toISOString(),
    options: { includeQuestions, includeData },
    instance: {
      appVersion,
      node: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      // Host only. The full URL is the owner's to share, but the path/query
      // never carries anything we need.
      baseUrlHost: (() => { try { return new URL(config.baseUrl).host; } catch { return null; } })(),
      signups: config.signups,
      mockAssistable: !!config.mockAssistable,
      encryptionKeyFromEnv: !!config.encryptionKeyFromEnv,
      setupTokenSet: !!config.setupToken,
      userCount: db.prepare("SELECT count(*) c FROM users").get().c,
      connectionStatus: db.prepare("SELECT status FROM connections LIMIT 1").get()?.status ?? "none",
      sourceCount: sources.length,
    },
    sources: sources.map((s) => {
      let meta = [];
      try { meta = JSON.parse(s.column_meta_json || "[]"); } catch { /* corrupt meta is itself a finding */ }
      const tool = db.prepare("SELECT tool_id, assistant_ids_json, last_error, created_at, updated_at FROM tools WHERE source_id = ?").get(s.id);
      const itemCount = db.prepare("SELECT count(*) c FROM items WHERE source_id = ? AND batch_id = ?").get(s.id, s.active_batch_id ?? "").c;
      const checks = checksSummary(db, s.id);

      const calls = includeQuestions
        ? db.prepare("SELECT ts, args_json, result_count, took_ms, outcome, flags, relaxations FROM tool_calls WHERE source_id = ? ORDER BY ts DESC LIMIT 40").all(s.id)
          .map((c) => {
            let q = "";
            try { q = JSON.parse(c.args_json)?.query ?? ""; } catch { /* keep empty */ }
            return {
              ts: c.ts, question: scrubText(q).slice(0, 200), outcome: c.outcome,
              resultCount: c.result_count, tookMs: c.took_ms, flags: c.flags || "",
            };
          })
        : [];

      return {
        id: s.id.slice(0, 8),
        type: s.type,
        name: s.name,
        status: s.status,
        scheduleMinutes: s.schedule_minutes,
        hasActiveBatch: !!s.active_batch_id,
        itemCount,
        lastSyncAt: s.last_sync_at,
        nextRunAt: s.next_run_at,
        consecutiveFailures: s.consecutive_failures,
        columns: columnFacts(meta, includeData),
        tool: tool
          ? {
            created: !!tool.tool_id,
            assistantCount: (() => { try { return JSON.parse(tool.assistant_ids_json).length; } catch { return 0; } })(),
            lastError: tool.last_error ?? null,
            schemaChangedSinceCreate: tool.updated_at > tool.created_at,
          }
          : { created: false, assistantCount: 0, lastError: null, schemaChangedSinceCreate: false },
        syncRuns: db.prepare("SELECT started_at, finished_at, status, items_count, error FROM sync_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 10").all(s.id)
          .map((r) => ({ startedAt: r.started_at, status: r.status, itemsCount: r.items_count, error: r.error ? String(r.error).slice(0, 300) : null })),
        quality: qualitySummary(db, { sourceId: s.id, days: 7 }),
        checks: {
          total: checks.total,
          passing: checks.passing,
          regressed: checks.regressed.map((r) => ({ question: scrubText(r.query).slice(0, 200), detail: r.detail })),
          flagged: checks.flagged.map((r) => ({ question: scrubText(r.query).slice(0, 200), note: scrubText(r.flag_note).slice(0, 300) })),
          lastRunAt: checks.lastRunAt,
        },
        recentCalls: calls,
        ...(includeData && s.active_batch_id
          ? {
            sampleRows: db.prepare("SELECT title, structured_json FROM items WHERE source_id = ? AND batch_id = ? LIMIT 10").all(s.id, s.active_batch_id)
              .map((i) => { try { return { title: i.title, ...JSON.parse(i.structured_json) }; } catch { return { title: i.title }; } }),
          }
          : {}),
      };
    }),
  };

  // The quality summary carries the questions it couldn't answer; strip them
  // when the owner opted out, and scrub them when they didn't.
  for (const s of bundle.sources) {
    s.quality.unanswered = includeQuestions
      ? (s.quality.unanswered ?? []).map((u) => ({ ...u, query: scrubText(u.query).slice(0, 200) }))
      : [];
  }
  return bundle;
}
