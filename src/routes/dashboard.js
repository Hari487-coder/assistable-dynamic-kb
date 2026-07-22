import { Router, json } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { createUser, createSession, sessionUser, requireUser, loginLimiter, verifyPassword, audit, cookieOpts } from "../auth.js";
import { ownedSource, ownedConnection } from "../tenant.js";
import { encryptSecret, decryptSecret, newSecret, constantTimeEqual } from "../crypto.js";
import { runSync, rollbackSource } from "../sync/engine.js";
import { buildToolDefinition } from "../assistable/tool-def.js";
import { qualitySummary } from "../analytics/quality.js";
import { answerQuery } from "../search/answer.js";
import { resolveGeoArgs } from "../search/geo.js";
import { mineChecks, runAnswerChecks, checksSummary } from "../analytics/answer-checks.js";
import { buildDiagnosticBundle } from "../diagnostics.js";

const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; }
  catch { return null; }
})();
import * as pages from "../views/pages.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const SOURCE_BODY = z.object({
  type: z.enum(["website", "feed", "csv", "database", "webtable"]),
  name: z.string().trim().min(1).max(60),
  schedule_minutes: z.coerce.number().int().min(15).max(10080).default(1440),
  url: z.string().url().optional(),
  url_feed: z.string().url().optional(),
  url_site: z.string().url().optional(),
  url_table: z.string().url().optional(),
  csv_text: z.string().max(5 * 1024 * 1024).optional(),
  connection_string: z.string().max(500).optional(),
  table: z.string().max(63).optional(),
  // A protected feed is the normal shape for a partner's data export: the
  // connector has always supported an auth header, the form just never let
  // anyone enter one, so key-protected feeds were unusable from the portal.
  auth_header_name: z.string().trim().max(64).optional(),
  auth_header_value: z.string().max(500).optional(),
  assistant_ids: z.array(z.string()).default([]),
});

export function createDashboardRouter(deps) {
  const { db, config, logger, connectors, makeClient } = deps;
  const router = Router();
  const now = () => new Date().toISOString();
  const guard = requireUser(db);

  router.get("/healthz", (_req, res) => res.json({ ok: true }));
  router.get("/", (req, res) => res.redirect(sessionUser(db, req.cookies?.sid) ? "/sources" : "/login"));
  const userCount = () => db.prepare("SELECT count(*) c FROM users").get().c;

  // Owner-only widget bench: embeds the tenant's own Assistable widget so the
  // full chain (widget -> assistant -> tool) is testable without the public
  // demo page whose stranger-traffic drained real credits. The widget script
  // is third-party, so this single authed page relaxes the CSP the rest of
  // the portal keeps strict.
  router.get("/widget-test", guard, (_req, res) => {
    res.set("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:");
    res.send(pages.widgetTestPage());
  });

  router.get("/login", (_req, res) => res.send(pages.loginPage()));
  router.get("/signup", (_req, res) => res.send(pages.signupPage(!!config.setupToken && userCount() === 0)));

  const signupsClosed = () => config.signups === "first-only" && userCount() > 0;

  router.post("/signup", loginLimiter, async (req, res) => {
    try {
      if (signupsClosed()) {
        return res.status(403).json({ ok: false, error: "signups are closed on this instance (self-hosted, first-only mode)" });
      }
      // A wiped disk leaves an unclaimed instance that the first visitor owns.
      // SETUP_TOKEN (an env var, which survives wipes) proves the claimer is
      // the person who deployed it.
      if (userCount() === 0 && config.setupToken && !constantTimeEqual(String(req.body?.setup_token || ""), config.setupToken)) {
        return res.status(403).json({ ok: false, error: "This instance requires its setup token for the first account. Enter the SETUP_TOKEN value you set when deploying." });
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
      // "invalid credentials" on an empty instance gaslights the real owner
      // after a disk wipe - their password was right, the account is gone.
      return res.status(401).json({ ok: false, error: userCount() === 0
        ? "No accounts exist on this instance. If it was redeployed recently, the disk was reset - sign up again to reclaim it, then restore your backup."
        : "invalid credentials" });
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
    const subAccountId = String(req.body?.subaccount_id || "").trim() || null;
    if (key.length < 8) {
      return res.status(400).json({ ok: false, error: "That key looks too short - copy the whole key from Assistable (it's only shown once)." });
    }
    const probe = await makeClient(key, subAccountId).verifyConnection();
    if (!probe.ok) {
      logger.warn("assistable connect failed", { userId: req.user.id, status: probe.status, code: probe.code });
      audit(db, req.user.id, "connect_failed", { status: probe.status, code: probe.code });
      return res.status(400).json({ ok: false, error: probe.reason, needs_subaccount: probe.code === "subaccount_required" });
    }
    db.prepare(`INSERT INTO connections (user_id, api_key_ct, status, subaccount_id, created_at, updated_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET api_key_ct=excluded.api_key_ct, status='verified',
                  subaccount_id=excluded.subaccount_id, updated_at=excluded.updated_at`)
      .run(req.user.id, encryptSecret(key, config.encryptionKey), "verified", subAccountId, now(), now());
    audit(db, req.user.id, "connect_assistable", { subaccount: subAccountId ? "set" : "auto" });
    res.json({ ok: true, assistants: probe.assistantCount });
  });

  const clientFor = (userId) => {
    const conn = ownedConnection(db, userId);
    if (!conn) return null;
    return makeClient(decryptSecret(conn.api_key_ct, config.encryptionKey), conn.subaccount_id);
  };

  const dataStats = (userId) => {
    const dbFile = path.join(config.dataDir, "kb-bridge.db");
    let dbSizeMb = null;
    try {
      // include WAL: with journal_mode=WAL most recent data lives there until checkpoint
      const bytes = fs.statSync(dbFile).size +
        (fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0);
      dbSizeMb = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    } catch { /* in-memory / test */ }
    let latestBackup = null;
    try {
      latestBackup = fs.readdirSync(path.join(config.dataDir, "backups")).filter((f) => f.startsWith("kb-")).sort().pop() ?? null;
    } catch { /* no backups yet */ }
    return {
      dbFile: dbSizeMb === null ? "in-memory (test mode)" : dbFile,
      dbSizeMb,
      itemCount: db.prepare(
        `SELECT count(*) c FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.user_id = ? AND i.batch_id = s.active_batch_id`
      ).get(userId).c,
      latestBackup,
    };
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
      data: dataStats(req.user.id),
      keyFromEnv: !!config.encryptionKeyFromEnv,
    }));
  });

  // One-click consistent snapshot of the whole instance (VACUUM INTO), streamed
  // as a download. This is the answer to "where is my data" — a file you hold.
  // Support export. Nobody can reach into a self-hosted instance, so the owner
  // sends a redacted picture of it instead. Allowlisted in src/diagnostics.js.
  router.get("/diagnostics", guard, (req, res) => {
    const bundle = buildDiagnosticBundle(db, config, {
      includeQuestions: req.query.questions !== "0",
      includeData: req.query.data === "1",
      appVersion: APP_VERSION,
    });
    audit(db, req.user.id, "diagnostics_downloaded", { includeData: req.query.data === "1" });
    res.setHeader("content-type", "application/json");
    res.setHeader("content-disposition", `attachment; filename="live-kb-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(bundle, null, 1));
  });

  router.get("/backup", guard, (req, res) => {
    const tmp = path.join(config.dataDir, `export-${crypto.randomUUID()}.db`);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''").replace(/\\/g, "/")}'`);
      audit(db, req.user.id, "backup_downloaded", {});
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", `attachment; filename="live-kb-backup-${new Date().toISOString().slice(0, 10)}.db"`);
      const stream = fs.createReadStream(tmp);
      stream.pipe(res);
      const cleanup = () => fs.unlink(tmp, () => {});
      stream.on("close", cleanup);
      stream.on("error", cleanup);
    } catch (err) {
      fs.unlink(tmp, () => {});
      logger.error("backup export failed", { error: String(err) });
      res.status(500).json({ ok: false, error: "backup failed" });
    }
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

  // Parsed here rather than app-wide: a 6MB buffer is only ever allocated for a
  // caller who already passed requireUser.
  const csvJson = json({ limit: "6mb" });
  router.post("/sources/new", guard, csvJson, upload.single("csv_file"), async (req, res) => {
    const parsed = SOURCE_BODY.safeParse({ ...req.body, csv_text: req.file ? req.file.buffer.toString("utf8") : req.body?.csv_text });
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    const b = parsed.data;
    const url = b.url ?? b.url_feed ?? b.url_site ?? b.url_table;
    const authHeader = b.auth_header_name && b.auth_header_value
      ? { name: b.auth_header_name, value: b.auth_header_value } : null;
    const cfg = b.type === "csv" ? { csv_text: b.csv_text }
      : b.type === "database" ? { connectionString: b.connection_string, table: b.table }
      : { url, ...(b.type === "feed" && authHeader ? { authHeader } : {}) };
    if (b.type === "csv" && !cfg.csv_text) return res.status(400).json({ ok: false, error: "CSV content required" });
    if (b.type !== "csv" && !cfg.url && !cfg.connectionString) return res.status(400).json({ ok: false, error: "config incomplete" });
    // Double-submits and impatient re-clicks created six identical sources for
    // one real user - each with its own tool in Assistable. Same name for the
    // same user is a duplicate, not a new source.
    const dup = db.prepare("SELECT id FROM sources WHERE user_id = ? AND name = ? COLLATE NOCASE").get(req.user.id, b.name);
    if (dup) {
      return res.status(409).json({ ok: false, error: `You already have a source called "${b.name}". Open it from Your data, or pick a different name.`, source_id: dup.id });
    }
    const id = crypto.randomUUID();
    const secret = newSecret();
    db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,schedule_minutes,secret,push_secret,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, b.type, b.name, encryptSecret(JSON.stringify(cfg), config.encryptionKey), b.schedule_minutes, secret, newSecret(), now());
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
    let source = ownedSource(db, req.user.id, req.params.id);
    if (!source) return res.status(404).send(pages.layoutPage("Not found", "<p>Not found</p>"));
    if (!source.push_secret) {
      // Backfill for sources created before the push API existed.
      db.prepare("UPDATE sources SET push_secret = ? WHERE id = ?").run(newSecret(), source.id);
      source = ownedSource(db, req.user.id, req.params.id);
    }
    const runs = db.prepare("SELECT * FROM sync_runs WHERE source_id=? ORDER BY started_at DESC LIMIT 10").all(source.id);
    const tool = db.prepare("SELECT * FROM tools WHERE source_id=?").get(source.id);
    const calls = db.prepare("SELECT * FROM tool_calls WHERE source_id=? ORDER BY ts DESC LIMIT 20").all(source.id);
    const quality = qualitySummary(db, { sourceId: source.id, days: 7 });
    res.send(pages.sourceDetailPage(source, runs, tool, calls, quality, checksSummary(db, source.id)));
  });

  const withOwned = (handler) => async (req, res) => {
    const source = ownedSource(db, req.user.id, req.params.id);
    if (!source) return res.status(404).json({ ok: false, error: "not found" });
    return handler(req, res, source);
  };

  // Re-test the questions callers actually asked, on demand. The same work the
  // nightly job does, so an owner can confirm a fix without waiting for 3am.
  router.post("/sources/:id/checks/run", guard, withOwned(async (req, res, source) => {
    if (!source.active_batch_id) return res.json({ ok: false, error: "This source hasn't finished its first sync yet." });
    mineChecks(db, source.id);
    const tally = runAnswerChecks(db, source.id, { logger });
    res.json({ ok: true, ...tally });
  }));

  // "This answer was wrong." The only trustworthy source of correctness is the
  // person who owns the data, so their verdict is recorded as a tracked issue
  // rather than inferred from a metric.
  router.post("/sources/:id/checks/flag", guard, withOwned(async (req, res, source) => {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "Which question gave the wrong answer?" });
    const note = String(req.body?.note || "").slice(0, 500);
    const ts = new Date().toISOString();
    const norm = query.toLowerCase().replace(/\s+/g, " ").trim();
    db.prepare(
      `INSERT INTO answer_checks (id, source_id, query, args_json, origin, status, detail, created_at, flagged_at, flag_note)
       VALUES (?,?,?,?,'owner','flagged',?,?,?,?)
       ON CONFLICT(source_id, query) DO UPDATE SET flagged_at = excluded.flagged_at, flag_note = excluded.flag_note`
    ).run(crypto.randomUUID(), source.id, norm, JSON.stringify({ query }), "Owner reported a wrong answer.", ts, ts, note);
    audit(db, req.user.id, "answer_flagged", { sourceId: source.id, query: norm.slice(0, 120) });
    res.json({ ok: true });
  }));

  router.post("/sources/:id/checks/clear", guard, withOwned(async (req, res, source) => {
    db.prepare("UPDATE answer_checks SET flagged_at = NULL, flag_note = NULL WHERE source_id = ? AND query = ?")
      .run(source.id, String(req.body?.query || "").toLowerCase().replace(/\s+/g, " ").trim());
    res.json({ ok: true });
  }));

  // Session-authed test search: same engine the tool webhook uses, so the
  // setup wizard can prove the answer before any real call happens.
  router.post("/sources/:id/test", guard, withOwned(async (req, res, source) => {
    const started = Date.now();
    if (!source.active_batch_id) return res.json({ ok: false, error: "not_synced" });
    let columns = [];
    try { columns = JSON.parse(source.column_meta_json || "[]"); } catch { columns = []; }
    // Same geocoding pre-step the live webhook runs, so "within 10 miles of X"
    // behaves in the Try-it box exactly as it will on a real call.
    const args = await resolveGeoArgs(columns, { query: String(req.body?.query || "") });
    res.json(answerQuery(db, source, args, { startedAt: started }));
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
