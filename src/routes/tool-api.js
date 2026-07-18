import express, { Router } from "express";
import { constantTimeEqual, encryptSecret } from "../crypto.js";
import { searchStructured } from "../search/structured.js";
import { searchText } from "../search/text.js";
import { buildToolResponse } from "../search/respond.js";
import { runSync } from "../sync/engine.js";

const DEADLINE_MS = 2500;
const RATE_LIMIT_PER_MIN = 60;
const PUSH_LIMIT_PER_MIN = 12;

export function createToolApiRouter({ db, logger, config, connectors }) {
  const router = Router();
  const buckets = new Map(); // `${kind}:${sourceId}` -> {windowStart, count}

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

  router.post("/api/tools/:sourceId/search", (req, res) => {
    const started = Date.now();
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.sourceId);
    const secret = req.get("x-bridge-secret") || "";
    if (!source || !constantTimeEqual(secret, source.secret)) return res.status(404).end();

    if (overLimit("tool", source.id, RATE_LIMIT_PER_MIN)) {
      return res.json(softError("rate_limited", "The live data system is briefly busy - try again in a few seconds."));
    }

    const body = req.body || {};
    const args = body.args && (body.meta_data || body.metadata || body.call) ? body.args : body;

    let out;
    try {
      if (!source.active_batch_id) {
        out = softError("not_synced", "The live data hasn't finished its first sync yet. Offer to take a message.");
      } else if (source.type === "website") {
        out = buildToolResponse({ source, textResult: searchText(db, source, args.query), args, tookMs: Date.now() - started });
      } else {
        const structured = searchStructured(db, source, args);
        out = buildToolResponse({ source, structured, args, tookMs: Date.now() - started });
      }
      if (Date.now() - started > DEADLINE_MS) {
        out = softError("temporarily_unavailable", "I couldn't check the live data just now - offer to try again in a moment.");
      }
    } catch (err) {
      logger.error("tool search failed", { sourceId: source.id, error: String(err) });
      out = softError("temporarily_unavailable", "I couldn't check the live data just now - offer to try again in a moment.");
    }

    try {
      db.prepare("INSERT INTO tool_calls (source_id,ts,args_json,result_count,relaxations,took_ms,ok) VALUES (?,?,?,?,?,?,?)")
        .run(source.id, new Date().toISOString(), JSON.stringify(args).slice(0, 2000),
             out.result_count ?? null, JSON.stringify(out.relaxations ?? []), Date.now() - started, out.ok ? 1 : 0);
    } catch (err) {
      logger.error("tool_calls insert failed", { error: String(err) });
    }
    res.json(out);
  });

  return router;
}
