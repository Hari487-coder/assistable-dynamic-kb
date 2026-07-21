import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret } from "../crypto.js";
import { tx } from "../db.js";
import { inferColumnMeta, rowToItem } from "../ingest/normalize.js";
import { runDailyChecks } from "../analytics/answer-checks.js";

const RETRY_MINUTES = [1, 5, 15];
const MAX_ITEMS_PER_SOURCE = 50_000;

export function classifyError(err) {
  if (err?.permanent === true) return "permanent";
  const m = String(err?.message || "");
  if (/HTTP 429/.test(m)) return "transient";
  if (/SSRF|parse|invalid|robots|table name|HTTP 4\d\d/.test(m)) return "permanent";
  return "transient";
}

export function recoverStuckRuns(db) {
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const stuck = db.prepare("SELECT id, source_id FROM sync_runs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)").all(cutoff);
  for (const run of stuck) {
    db.prepare("UPDATE sync_runs SET status='failed', finished_at=?, error='crashed (recovered on boot)' WHERE id=?")
      .run(new Date().toISOString(), run.id);
    db.prepare("UPDATE sources SET status = CASE WHEN active_batch_id IS NULL THEN 'error' ELSE 'active' END WHERE id=? AND status='syncing'")
      .run(run.source_id);
  }
  return stuck.length;
}

export async function runSync(deps, sourceId, { manual = false, force = false } = {}) {
  const { db, config, logger, connectors } = deps;
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
  if (!source) return { ok: false, error: "source not found" };
  if (source.status === "syncing") return { ok: false, error: "sync already running" };

  const runId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const now = () => new Date().toISOString();
  db.prepare("INSERT INTO sync_runs (id,source_id,batch_id,started_at,heartbeat_at,status,manual) VALUES (?,?,?,?,?,'running',?)")
    .run(runId, sourceId, batchId, now(), now(), manual ? 1 : 0);
  db.prepare("UPDATE sources SET status='syncing' WHERE id=?").run(sourceId);
  const heartbeat = setInterval(() => {
    try { db.prepare("UPDATE sync_runs SET heartbeat_at=? WHERE id=?").run(now(), runId); } catch { /* shutting down */ }
  }, 10_000);

  const finishFail = (error, kind) => {
    db.prepare("UPDATE sync_runs SET status='failed', finished_at=?, error=? WHERE id=?").run(now(), error, runId);
    const failures = source.consecutive_failures + 1;
    const hasData = !!source.active_batch_id;
    const status = kind === "permanent" ? "error" : failures >= 3 ? "stale" : hasData ? "active" : "error";
    const delayMin = kind === "permanent" ? null : RETRY_MINUTES[Math.min(failures - 1, RETRY_MINUTES.length - 1)];
    db.prepare("UPDATE sources SET status=?, consecutive_failures=?, next_run_at=? WHERE id=?")
      .run(status, failures, delayMin ? new Date(Date.now() + delayMin * 60_000).toISOString() : null, sourceId);
    logger.error("sync failed", { sourceId, runId, kind, error });
    return { ok: false, runId, error };
  };

  try {
    const cfg = JSON.parse(decryptSecret(source.config_ct, config.encryptionKey));
    const connector = connectors[source.type];
    if (!connector) return finishFail(`no connector for type ${source.type}`, "permanent");
    const { rows } = await connector(cfg);
    if (rows.length > MAX_ITEMS_PER_SOURCE) {
      return finishFail(`source has ${rows.length} rows; the per-source limit is ${MAX_ITEMS_PER_SOURCE} (split into multiple sources or narrow the feed)`, "permanent");
    }

    const columns = source.type === "website"
      ? [{ name: "page_url", kind: "text" }, { name: "heading", kind: "text" }, { name: "content", kind: "text" }]
      : inferColumnMeta(rows);

    const oldCount = source.active_batch_id
      ? db.prepare("SELECT count(*) c FROM items WHERE source_id=? AND batch_id=?").get(sourceId, source.active_batch_id).c
      : 0;
    if (rows.length < 1 || (oldCount > 0 && rows.length < 0.3 * oldCount && !force)) {
      return finishFail(`validation gate: new batch has ${rows.length} rows vs previous ${oldCount} (use force to override)`, "transient");
    }

    const insert = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
    tx(db, () => {
      for (const row of rows) {
        const item = source.type === "website"
          ? { title: row.heading || "", body: `${row.heading || ""} ${row.content || ""}`.trim(), structured: row }
          : rowToItem(row, columns);
        insert.run(crypto.randomUUID(), sourceId, batchId, String(item.title).slice(0, 300), String(item.body).slice(0, 8000), JSON.stringify(item.structured));
      }
      const dropBefore = source.prev_batch_id;
      if (dropBefore) db.prepare("DELETE FROM items WHERE source_id=? AND batch_id=?").run(sourceId, dropBefore);
      const jitter = 1 + (Math.random() * 0.2 - 0.1);
      db.prepare(`UPDATE sources SET prev_batch_id=active_batch_id, active_batch_id=?, column_meta_json=?,
                  status='active', consecutive_failures=0, last_sync_at=?, next_run_at=? WHERE id=?`)
        .run(batchId, JSON.stringify(columns), now(),
             new Date(Date.now() + source.schedule_minutes * 60_000 * jitter).toISOString(), sourceId);
      db.prepare("UPDATE sync_runs SET status='success', finished_at=?, items_count=? WHERE id=?").run(now(), rows.length, runId);
    });
    logger.info("sync ok", { sourceId, runId, items: rows.length });
    return { ok: true, runId, itemsCount: rows.length };
  } catch (err) {
    return finishFail(String(err?.message || err), classifyError(err));
  } finally {
    clearInterval(heartbeat);
  }
}

export function rollbackSource(db, sourceId) {
  const s = db.prepare("SELECT active_batch_id, prev_batch_id FROM sources WHERE id=?").get(sourceId);
  if (!s?.prev_batch_id) return false;
  db.prepare("UPDATE sources SET active_batch_id=?, prev_batch_id=? WHERE id=?").run(s.prev_batch_id, s.active_batch_id, sourceId);
  const last = db.prepare("SELECT id FROM sync_runs WHERE source_id=? ORDER BY started_at DESC LIMIT 1").get(sourceId);
  if (last) db.prepare("UPDATE sync_runs SET status='rolled_back' WHERE id=?").run(last.id);
  return true;
}

export function startScheduler(deps, { tickMs = 30_000 } = {}) {
  const { db, config, logger } = deps;
  recoverStuckRuns(db);
  let running = 0;
  let lastBackupDay = "";
  const timer = setInterval(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (new Date().getHours() >= 3 && lastBackupDay !== today) {
        lastBackupDay = today;
        backup(db, config.dataDir, logger);
        runRetention(db, logger);
        // Same quiet hour as the backup: replay the questions callers actually
        // ask, so a source that silently stopped answering surfaces here rather
        // than in a customer's phone call.
        runDailyChecks(db, { logger });
      }
      const due = db.prepare(`SELECT id FROM sources WHERE status != 'syncing' AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 4`)
        .all(new Date().toISOString());
      for (const { id } of due) {
        if (running >= 2) break;
        running++;
        runSync(deps, id, {}).finally(() => { running--; });
      }
    } catch (err) {
      logger.error("scheduler tick failed", { error: String(err) });
    }
  }, tickMs);
  return { stop: () => clearInterval(timer) };
}

/** Long-run hygiene: logs must not grow without bound on a small free host. */
export function runRetention(db, logger, now = Date.now()) {
  const cutoff = (days) => new Date(now - days * 864e5).toISOString();
  const calls = db.prepare("DELETE FROM tool_calls WHERE ts < ?").run(cutoff(90)).changes;
  const runs = db.prepare("DELETE FROM sync_runs WHERE started_at < ? AND status != 'running'").run(cutoff(90)).changes;
  const audits = db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff(180)).changes;
  if (calls || runs || audits) logger.info("retention pruned", { calls, runs, audits });
  return { calls, runs, audits };
}

function backup(db, dataDir, logger) {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `kb-${new Date().toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''").replace(/\\/g, "/")}'`);
    const keep = fs.readdirSync(dir).filter((f) => f.startsWith("kb-")).sort().reverse().slice(7);
    for (const f of keep) fs.unlinkSync(path.join(dir, f));
    logger.info("backup written", { file });
  } catch (err) {
    logger.error("backup failed", { error: String(err) });
  }
}
