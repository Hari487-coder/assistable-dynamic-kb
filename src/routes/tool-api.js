import { Router } from "express";
import { constantTimeEqual } from "../crypto.js";
import { searchStructured } from "../search/structured.js";
import { searchText } from "../search/text.js";
import { buildToolResponse } from "../search/respond.js";

const DEADLINE_MS = 2500;
const RATE_LIMIT_PER_MIN = 60;

export function createToolApiRouter({ db, logger }) {
  const router = Router();
  const buckets = new Map(); // sourceId -> {windowStart, count}

  const softError = (error, hint) => ({ ok: false, error, speech_hint: hint });

  router.post("/api/tools/:sourceId/search", (req, res) => {
    const started = Date.now();
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(req.params.sourceId);
    const secret = req.get("x-bridge-secret") || "";
    if (!source || !constantTimeEqual(secret, source.secret)) return res.status(404).end();

    const bucket = buckets.get(source.id) || { windowStart: started, count: 0 };
    if (started - bucket.windowStart > 60_000) { bucket.windowStart = started; bucket.count = 0; }
    bucket.count++; buckets.set(source.id, bucket);
    if (bucket.count > RATE_LIMIT_PER_MIN) {
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
