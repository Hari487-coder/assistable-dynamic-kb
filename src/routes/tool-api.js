import express, { Router } from "express";
import { constantTimeEqual, encryptSecret, sha256Hex } from "../crypto.js";
import { searchStructured } from "../search/structured.js";
import { answerQuery } from "../search/answer.js";
import { runSync } from "../sync/engine.js";
import { classifyOutcome, callFlags } from "../analytics/quality.js";
import { findGeoCols, geocodeUK, parseGeoFromQuery } from "../search/geo.js";

const DEADLINE_MS = 2500;
const RATE_LIMIT_PER_MIN = 60;
const PUSH_LIMIT_PER_MIN = 12;

// Conversation memory: no static KB can do this. Keyed by the platform's
// call_control_id header (call id on voice, conversation id on chat), it lets
// an anaphoric follow-up - "what about the 2021?" - inherit the filters the
// caller established moments ago. Deliberately conservative: only queries that
// LOOK like follow-ups carry context, explicit filters always win, and every
// carried filter is disclosed in `relaxations`.
const CONV_TTL_MS = 10 * 60_000;
const CONV_MAX = 1000;
const ANAPHORA_RE = /\b(?:what|how)\s+about\b|^\s*and\b|\bthe\s+(?:19[5-9]\d|20[0-4]\d|other|cheaper|cheapest|newer|newest|older|first|second)\b|\bthat\s+one\b|\binstead\b/i;

function convSweep(mem) {
  if (mem.size <= CONV_MAX) return;
  const cutoff = Date.now() - CONV_TTL_MS;
  for (const [k, v] of mem) if (v.ts < cutoff) mem.delete(k);
  while (mem.size > CONV_MAX) mem.delete(mem.keys().next().value);
}

export function createToolApiRouter({ db, logger, config, connectors, geocode = geocodeUK }) {
  const router = Router();
  const buckets = new Map(); // `${kind}:${sourceId}` -> {windowStart, count}
  const convMem = new Map(); // `${sourceId}:${callId}` -> {filters, ts}
  // Result micro-cache: the platform proxy retries timeouts up to 4x and voice
  // callers repeat themselves. Keyed on the active batch id, so every sync
  // swap invalidates naturally; keyed on callId so conversation-context
  // answers never leak between calls.
  const resultCache = new Map(); // key -> {out, ts}
  const CACHE_TTL_MS = 60_000, CACHE_MAX = 500;

  const softError = (error, hint) => ({ ok: false, error, speech_hint: hint });

  const overLimit = (kind, sourceId, limit) => {
    const key = `${kind}:${sourceId}`;
    const now = Date.now();
    const bucket = buckets.get(key) || { windowStart: now, count: 0 };
    if (now - bucket.windowStart > 60_000) { bucket.windowStart = now; bucket.count = 0; }
    bucket.count++; buckets.set(key, bucket);
    return bucket.count > limit;
  };

  // ---- Push API: live-pricing niches update us instead of waiting for the
  // schedule. Authenticated by a per-source push secret (distinct from the
  // tool secret Assistable holds - reads and writes never share a credential).
  if (config && connectors) {
    const pushAuth = (req, res) => {
      const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.sourceId);
      const secret = req.get("x-push-secret") || "";
      if (!source?.push_secret || !constantTimeEqual(secret, source.push_secret)) {
        res.status(404).end();
        return null;
      }
      if (overLimit("push", source.id, PUSH_LIMIT_PER_MIN)) {
        res.status(429).json({ ok: false, error: "rate_limited" });
        return null;
      }
      return source;
    };

    router.post("/api/push/:sourceId/refresh", (req, res) => {
      const source = pushAuth(req, res);
      if (!source) return;
      runSync({ db, config, logger, connectors }, source.id, { manual: true })
        .catch((err) => logger.error("push refresh failed", { sourceId: source.id, error: String(err) }));
      res.status(202).json({ ok: true, started: true });
    });

    router.post("/api/push/:sourceId/content",
      express.text({ type: () => true, limit: "5mb" }),
      async (req, res) => {
        const source = pushAuth(req, res);
        if (!source) return;
        if (source.type !== "csv") {
          return res.status(400).json({ ok: false, error: "content push is only supported for csv sources; use /refresh for pull connectors" });
        }
        const text = String(req.body || "").trim();
        if (!text) return res.status(400).json({ ok: false, error: "empty body" });
        db.prepare("UPDATE sources SET config_ct = ? WHERE id = ?")
          .run(encryptSecret(JSON.stringify({ csv_text: text }), config.encryptionKey), source.id);
        const r = await runSync({ db, config, logger, connectors }, source.id,
          { manual: true, force: req.query.force === "1" });
        res.status(r.ok ? 200 : 422).json({ ok: r.ok, items_count: r.itemsCount, error: r.error });
      });
  }

  router.post("/api/tools/:sourceId/search", async (req, res) => {
    const started = Date.now();
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.sourceId);
    const secret = req.get("x-bridge-secret") || "";
    if (!source || !constantTimeEqual(secret, source.secret)) return res.status(404).end();

    if (overLimit("tool", source.id, RATE_LIMIT_PER_MIN)) {
      return res.json(softError("rate_limited", "The live data system is briefly busy - try again in a few seconds."));
    }

    const body = req.body || {};
    let args = body.args && (body.meta_data || body.metadata || body.call) ? body.args : body;

    const callId = req.get("call_control_id") || body.call?.call_id || null;
    const convKey = callId ? `${source.id}:${callId}` : null;

    const cacheKey = `${source.id}:${source.active_batch_id}:${callId ?? ""}:${sha256Hex(JSON.stringify(args))}`;
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return res.json({ ...hit.out, cached: true });
    }

    let out;
    try {
      if (!source.active_batch_id) {
        out = softError("not_synced", "The live data hasn't finished its first sync yet. Offer to take a message.");
      } else if (source.type === "website") {
        out = answerQuery(db, source, args, { startedAt: started });
      } else {
        // Resolve a spoken location ("near CR4 4HX", near+radius_miles args)
        // to coordinates before the synchronous search. Soft everywhere: no
        // geo columns, unresolvable place, or a dead geocoder just means the
        // search runs without the distance leg.
        try {
          let columns = [];
          try { columns = JSON.parse(source.column_meta_json || "[]"); } catch { columns = []; }
          if (Array.isArray(columns) && findGeoCols(columns)) {
            const fromQuery = parseGeoFromQuery(String(args.query ?? ""));
            const near = typeof args.near === "string" && args.near.trim() ? args.near.trim() : fromQuery?.near;
            if (near) {
              const radiusMiles = Number(args.radius_miles) > 0 ? Number(args.radius_miles) : fromQuery?.radiusMiles ?? 25;
              const pt = await geocode(near);
              args = pt
                ? { ...args, _geo: { ...pt, radiusMiles }, query: fromQuery?.matched ? String(args.query ?? "").replace(fromQuery.matched, " ") : args.query }
                : { ...args, _geoFail: near };
            }
          }
        } catch { /* the distance leg must never break the answer */ }
        let structured = searchStructured(db, source, args);
        // Anaphoric follow-up: re-run with the call's earlier filters filled in
        // (current filters win on any column they share).
        const mem = convKey ? convMem.get(convKey) : null;
        if (mem && Date.now() - mem.ts < CONV_TTL_MS && ANAPHORA_RE.test(String(args.query || ""))) {
          const carried = Object.fromEntries(Object.entries(mem.filters)
            .filter(([k]) => !(k in structured.appliedFilters) && !(`${k.replace(/_(min|max)$/, "")}` in structured.appliedFilters)));
          // Location carries like any other filter: "and copper piping?" after
          // a located question stays near the caller. (Geocode is cached, so
          // the repeat lookup is free.)
          if (carried.near && !args._geo) {
            const pt = await geocode(String(carried.near)).catch(() => null);
            if (pt) args = { ...args, _geo: { ...pt, radiusMiles: Number(carried.radius_miles) > 0 ? Number(carried.radius_miles) : 25 } };
          }
          if (Object.keys(carried).length) {
            const merged = searchStructured(db, source, { ...args, filters: { ...carried, ...(args.filters || {}), ...structured.appliedFilters } });
            if (merged.resultCount > 0 || merged.alternatives.length > 0) {
              merged.relaxations.push(`carried from earlier in this conversation: ${Object.entries(carried).map(([k, v]) => `${k}=${v}`).join(", ")}`);
              structured = merged;
            }
          }
        }
        if (convKey && Object.keys(structured.appliedFilters).length) {
          convMem.set(convKey, { filters: structured.appliedFilters, ts: Date.now() });
          convSweep(convMem);
        }
        out = answerQuery(db, source, args, { startedAt: started, structured });
      }
      if (Date.now() - started > DEADLINE_MS) {
        out = softError("temporarily_unavailable", "I couldn't check the live data just now - offer to try again in a moment.");
      }
    } catch (err) {
      logger.error("tool search failed", { sourceId: source.id, error: String(err) });
      out = softError("temporarily_unavailable", "I couldn't check the live data just now - offer to try again in a moment.");
    }

    if (out.ok) {
      resultCache.set(cacheKey, { out, ts: Date.now() });
      if (resultCache.size > CACHE_MAX) {
        const cutoff = Date.now() - CACHE_TTL_MS;
        for (const [k, v] of resultCache) if (v.ts < cutoff) resultCache.delete(k);
        while (resultCache.size > CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
      }
    }
    try {
      db.prepare(`INSERT INTO tool_calls (source_id,ts,args_json,result_count,relaxations,took_ms,ok,outcome,flags)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(source.id, new Date().toISOString(), JSON.stringify(args).slice(0, 2000),
             out.result_count ?? null, JSON.stringify(out.relaxations ?? []), Date.now() - started,
             out.ok ? 1 : 0, classifyOutcome(out), callFlags(out));
    } catch (err) {
      logger.error("tool_calls insert failed", { error: String(err) });
    }
    res.json(out);
  });

  return router;
}
