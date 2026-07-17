import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { createUser, createSession, sessionUser, requireUser, loginLimiter, verifyPassword, audit, cookieOpts } from "../auth.js";
import { ownedSource, ownedConnection } from "../tenant.js";
import { encryptSecret, decryptSecret, newSecret } from "../crypto.js";
import { runSync, rollbackSource } from "../sync/engine.js";
import { buildToolDefinition } from "../assistable/tool-def.js";
import * as pages from "../views/pages.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SOURCE_BODY = z.object({
  type: z.enum(["website", "feed", "csv", "database"]),
  name: z.string().trim().min(1).max(60),
  schedule_minutes: z.coerce.number().int().min(15).max(10080).default(1440),
  url: z.string().url().optional(),
  csv_text: z.string().max(5 * 1024 * 1024).optional(),
  connection_string: z.string().max(500).optional(),
  table: z.string().max(63).optional(),
  assistant_ids: z.array(z.string()).default([]),
});

export function createDashboardRouter(deps) {
  const { db, config, logger, connectors, makeClient } = deps;
  const router = Router();
  const now = () => new Date().toISOString();
  const guard = requireUser(db);

  router.get("/healthz", (_req, res) => res.json({ ok: true }));
  router.get("/", (req, res) => res.redirect(sessionUser(db, req.cookies?.sid) ? "/sources" : "/login"));
  router.get("/login", (_req, res) => res.send(pages.loginPage()));
  router.get("/signup", (_req, res) => res.send(pages.signupPage()));

  const signupsClosed = () =>
    config.signups === "first-only" && db.prepare("SELECT count(*) c FROM users").get().c > 0;

  router.post("/signup", loginLimiter, async (req, res) => {
    try {
      if (signupsClosed()) {
        return res.status(403).json({ ok: false, error: "signups are closed on this instance (self-hosted, first-only mode)" });
      }
      const user = await createUser(db, req.body?.email, req.body?.password);
      audit(db, user.id, "signup", { email: user.email });
      res.cookie("sid", createSession(db, user.id), cookieOpts(config.nodeEnv));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: String(e.message) }); }
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(req.body?.email || "").toLowerCase());
    if (!user || !(await verifyPassword(String(req.body?.password || ""), user.password_hash))) {
      audit(db, user?.id ?? null, "login_failed", { email: req.body?.email });
      return res.status(401).json({ ok: false, error: "invalid credentials" });
    }
    audit(db, user.id, "login", {});
    res.cookie("sid", createSession(db, user.id), cookieOpts(config.nodeEnv));
    res.json({ ok: true });
  });

  router.post("/logout", guard, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.user.id);
    res.clearCookie("sid").json({ ok: true });
  });

  router.get("/connect", guard, (req, res) => {
    const conn = ownedConnection(db, req.user.id);
    res.send(pages.connectPage(conn && { status: conn.status }));
  });

  router.post("/connect", guard, async (req, res) => {
    const key = String(req.body?.api_key || "").trim();
    if (key.length < 8) return res.status(400).json({ ok: false, error: "key looks too short" });
    const client = makeClient(key);
    if (!(await client.verifyKey())) return res.status(400).json({ ok: false, error: "Assistable rejected this key" });
    db.prepare(`INSERT INTO connections (user_id, api_key_ct, status, created_at, updated_at) VALUES (?,?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET api_key_ct=excluded.api_key_ct, status='verified', updated_at=excluded.updated_at`)
      .run(req.user.id, encryptSecret(key, config.encryptionKey), "verified", now(), now());
    audit(db, req.user.id, "connect_assistable", {});
    res.json({ ok: true });
  });

  const clientFor = (userId) => {
    const conn = ownedConnection(db, userId);
    if (!conn) return null;
    return makeClient(decryptSecret(conn.api_key_ct, config.encryptionKey));
  };

  router.get("/setup", guard, (req, res) => {
    const conn = ownedConnection(db, req.user.id);
    const first = db.prepare("SELECT * FROM sources WHERE user_id = ? ORDER BY created_at ASC LIMIT 1").get(req.user.id);
    const count = db.prepare("SELECT count(*) c FROM sources WHERE user_id = ?").get(req.user.id).c;
    const tool = first ? db.prepare("SELECT * FROM tools WHERE source_id = ?").get(first.id) : null;
    res.send(pages.setupPage({
      connected: !!conn,
      sourceCount: count,
      firstSourceId: first?.id,
      firstSourceName: first?.name,
      firstTool: tool,
      firstToolName: tool?.tool_id ? `the live_data_${String(first?.name || "").replace(/[^a-zA-Z0-9_-]+/g, "_")} tool` : null,
    }));
  });

  router.get("/sources", guard, (req, res) => {
    const sources = db.prepare("SELECT * FROM sources WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
    res.send(pages.sourcesPage(sources));
  });

  router.get("/sources/new", guard, async (req, res) => {
    const client = clientFor(req.user.id);
    const assistants = client ? await client.listAssistants().catch(() => []) : [];
    res.send(pages.newSourcePage(assistants, !client));
  });

  router.post("/sources/new", guard, upload.single("csv_file"), async (req, res) => {
    const parsed = SOURCE_BODY.safeParse({ ...req.body, csv_text: req.file ? req.file.buffer.toString("utf8") : req.body?.csv_text });
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    const b = parsed.data;
    const cfg = b.type === "csv" ? { csv_text: b.csv_text }
      : b.type === "database" ? { connectionString: b.connection_string, table: b.table }
      : { url: b.url };
    if (b.type === "csv" && !cfg.csv_text) return res.status(400).json({ ok: false, error: "CSV content required" });
    if (b.type !== "csv" && !cfg.url && !cfg.connectionString) return res.status(400).json({ ok: false, error: "config incomplete" });
    const id = crypto.randomUUID();
    const secret = newSecret();
    db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,schedule_minutes,secret,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, b.type, b.name, encryptSecret(JSON.stringify(cfg), config.encryptionKey), b.schedule_minutes, secret, now());
    audit(db, req.user.id, "source_created", { id, type: b.type });

    const sync = await runSync({ db, config, logger, connectors }, id, { manual: true });
    if (!sync.ok) return res.json({ ok: true, source_id: id, warning: `created, but first sync failed: ${sync.error}` });

    const client = clientFor(req.user.id);
    if (client) {
      try {
        const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
        const def = buildToolDefinition(source, JSON.parse(source.column_meta_json), { baseUrl: config.baseUrl, secret });
        const tool = await client.createTool(def);
        for (const aid of b.assistant_ids) await client.assignTool(tool.id, aid);
        db.prepare("INSERT INTO tools (source_id,tool_id,assistant_ids_json,created_at,updated_at) VALUES (?,?,?,?,?)")
          .run(id, tool.id, JSON.stringify(b.assistant_ids), now(), now());
        audit(db, req.user.id, "tool_provisioned", { source_id: id, tool_id: tool.id });
      } catch (e) {
        db.prepare("INSERT INTO tools (source_id,tool_id,assistant_ids_json,last_error,created_at,updated_at) VALUES (?,NULL,'[]',?,?,?)")
          .run(id, String(e.message), now(), now());
      }
    }
    res.json({ ok: true, source_id: id });
  });

  router.get("/sources/:id", guard, (req, res) => {
    const source = ownedSource(db, req.user.id, req.params.id);
    if (!source) return res.status(404).send(pages.layoutPage("Not found", "<p>Not found</p>"));
    const runs = db.prepare("SELECT * FROM sync_runs WHERE source_id=? ORDER BY started_at DESC LIMIT 10").all(source.id);
    const tool = db.prepare("SELECT * FROM tools WHERE source_id=?").get(source.id);
    const calls = db.prepare("SELECT * FROM tool_calls WHERE source_id=? ORDER BY ts DESC LIMIT 20").all(source.id);
    const unanswered = db.prepare("SELECT args_json, count(*) n FROM tool_calls WHERE source_id=? AND result_count=0 GROUP BY args_json ORDER BY n DESC LIMIT 10").all(source.id);
    res.send(pages.sourceDetailPage(source, runs, tool, calls, unanswered));
  });

  const withOwned = (handler) => async (req, res) => {
    const source = ownedSource(db, req.user.id, req.params.id);
    if (!source) return res.status(404).json({ ok: false, error: "not found" });
    return handler(req, res, source);
  };

  // Session-authed test search: same engine the tool webhook uses, so the
  // setup wizard can prove the answer before any real call happens.
  router.post("/sources/:id/test", guard, withOwned(async (req, res, source) => {
    const { searchStructured } = await import("../search/structured.js");
    const { searchText } = await import("../search/text.js");
    const { buildToolResponse } = await import("../search/respond.js");
    const started = Date.now();
    if (!source.active_batch_id) return res.json({ ok: false, error: "not_synced" });
    const args = { query: String(req.body?.query || "") };
    const out = source.type === "website"
      ? buildToolResponse({ source, textResult: searchText(db, source, args.query), args, tookMs: Date.now() - started })
      : buildToolResponse({ source, structured: searchStructured(db, source, args), args, tookMs: Date.now() - started });
    res.json(out);
  }));

  router.post("/sources/:id/sync", guard, withOwned(async (req, res, source) => {
    const r = await runSync({ db, config, logger, connectors }, source.id, { manual: true, force: !!req.body?.force });
    res.json({ ok: r.ok, error: r.error });
  }));

  router.post("/sources/:id/rollback", guard, withOwned((req, res, source) => {
    res.json({ ok: rollbackSource(db, source.id) });
  }));

  router.post("/sources/:id/delete", guard, withOwned(async (req, res, source) => {
    const tool = db.prepare("SELECT * FROM tools WHERE source_id=?").get(source.id);
    const client = clientFor(req.user.id);
    if (tool?.tool_id && client) {
      for (const aid of JSON.parse(tool.assistant_ids_json)) await client.removeTool(tool.tool_id, aid).catch(() => {});
      await client.deleteTool(tool.tool_id).catch(() => {});
    }
    db.prepare("DELETE FROM sources WHERE id=?").run(source.id);
    audit(db, req.user.id, "source_deleted", { id: source.id });
    res.json({ ok: true });
  }));

  return router;
}
