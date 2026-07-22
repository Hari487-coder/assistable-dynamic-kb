import crypto from "node:crypto";
import { hashPassword, audit } from "./auth.js";
import { encryptSecret, newSecret } from "./crypto.js";
import { runSync } from "./sync/engine.js";
import { buildToolDefinition } from "./assistable/tool-def.js";

// Self-healing for ephemeral disks. Free hosts wipe the filesystem on every
// redeploy - account, connection, sources, tools, all gone - and the owner
// rebuilds by hand while their agent answers "not synced". Env vars are the
// one thing that survives a wipe, so BOOTSTRAP holds the whole setup as JSON:
//
//   BOOTSTRAP={"email":"you@x.co","password":"...","assistable_api_key":"ak-...",
//     "subaccount_id":"...","sources":[{"type":"webtable","name":"Scrap Prices",
//     "url":"https://...","schedule_minutes":60,"assistant_ids":["..."]}]}
//
// On boot with an EMPTY users table, everything is recreated and synced; on an
// instance that already has an account it does nothing at all, so it is safe
// to leave set permanently. Sync failures don't abort the boot - a source that
// can't fetch right now is still recreated and will retry on schedule.
export async function bootstrapFromEnv({ db, config, logger, connectors, makeClient }) {
  if (!config.bootstrap) return { ran: false, reason: "no BOOTSTRAP configured" };
  if (db.prepare("SELECT count(*) c FROM users").get().c > 0) {
    return { ran: false, reason: "instance already claimed" };
  }
  let plan;
  try { plan = JSON.parse(config.bootstrap); } catch {
    logger.error("BOOTSTRAP env var is not valid JSON - skipping self-restore");
    return { ran: false, reason: "invalid JSON" };
  }
  const email = String(plan.email || "").trim().toLowerCase();
  const password = String(plan.password || "");
  if (!email.includes("@") || password.length < 10) {
    logger.error("BOOTSTRAP needs email and a password of 10+ chars - skipping self-restore");
    return { ran: false, reason: "email/password missing" };
  }
  const now = () => new Date().toISOString();
  const userId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)")
    .run(userId, email, await hashPassword(password), now());
  audit(db, userId, "bootstrap_account", { email });

  let client = null;
  const apiKey = String(plan.assistable_api_key || "").trim();
  const subaccount = String(plan.subaccount_id || "").trim() || null;
  if (apiKey) {
    client = makeClient(apiKey, subaccount);
    const probe = await client.verifyConnection();
    db.prepare(`INSERT INTO connections (user_id, api_key_ct, status, subaccount_id, created_at, updated_at)
                VALUES (?,?,?,?,?,?)`)
      .run(userId, encryptSecret(apiKey, config.encryptionKey), probe.ok ? "verified" : "unverified", subaccount, now(), now());
    if (!probe.ok) {
      logger.warn("bootstrap: Assistable key stored but did not verify", { reason: probe.reason });
      client = null; // tools can't be provisioned; sources still get recreated
    }
  }

  // Stable across wipes: the tool's URL embeds the source id and its auth is
  // the source secret, so if BOTH are derived from the ENCRYPTION_KEY (an env
  // var that survives wipes) instead of randomised, a tool created in a past
  // life keeps working after a redeploy - no dead orphans, no accumulation.
  const stableUuid = (seed) => {
    const h = crypto.createHash("sha256").update(`${config.encryptionKey}:${seed}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const stableSecret = (seed) => crypto.createHmac("sha256", config.encryptionKey).update(seed).digest("base64url");

  const summary = { ran: true, email, sources: 0, tools: 0, warnings: [] };
  for (const s of Array.isArray(plan.sources) ? plan.sources : []) {
    try {
      const type = String(s.type || "");
      const cfg = type === "csv" ? { csv_text: s.csv_text }
        : type === "database" ? { connectionString: s.connection_string ?? s.connectionString, table: s.table }
        : { url: s.url };
      const sourceId = stableUuid(`source:${s.name}`);
      const secret = stableSecret(`tool-secret:${s.name}`);
      db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,schedule_minutes,secret,push_secret,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(sourceId, userId, type, String(s.name || "Live data"),
             encryptSecret(JSON.stringify(cfg), config.encryptionKey),
             Number(s.schedule_minutes) || 1440, secret, stableSecret(`push-secret:${s.name}`), now());
      summary.sources++;

      const sync = await runSync({ db, config, logger, connectors }, sourceId, { manual: true });
      if (!sync.ok) summary.warnings.push(`source "${s.name}": first sync failed (${sync.error}); will retry on schedule`);

      if (client) {
        const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
        const def = buildToolDefinition(source, JSON.parse(source.column_meta_json || "[]"), { baseUrl: config.baseUrl, secret });
        // Sweep same-named tools from past lives, INCLUDING the "-2"/"-3"
        // variants a 409-rename left behind (the old exact-match missed those,
        // which is how three copies piled up on one assistant). The freshly
        // recreated source has the same stable URL+secret, so anything we miss
        // still works rather than 404s.
        let existingTool = null;
        try {
          const existing = await client.listTools();
          for (const t of Array.isArray(existing) ? existing : []) {
            if (!t?.id || typeof t?.name !== "string") continue;
            if (t.name === def.name) existingTool = t;              // reuse the canonical one
            else if (t.name.startsWith(`${def.name}-`)) await client.deleteTool(t.id).catch(() => {}); // drop the -2/-3 dupes
          }
        } catch { /* list unsupported - reuse-by-create below still yields a working tool */ }
        const tool = existingTool ?? await client.createTool(def);
        if (existingTool) await client.updateTool(tool.id, def).catch(() => {}); // refresh its schema/secret in place
        const assistantIds = Array.isArray(s.assistant_ids) ? s.assistant_ids : [];
        for (const aid of assistantIds) await client.assignTool(tool.id, aid).catch((e) =>
          summary.warnings.push(`source "${s.name}": could not attach assistant ${aid} (${e.message})`));
        db.prepare("INSERT INTO tools (source_id,tool_id,assistant_ids_json,created_at,updated_at) VALUES (?,?,?,?,?)")
          .run(sourceId, tool.id, JSON.stringify(assistantIds), now(), now());
        summary.tools++;
      }
    } catch (e) {
      summary.warnings.push(`source "${s?.name}": ${String(e.message)}`);
    }
  }
  audit(db, userId, "bootstrap_restored", { sources: summary.sources, tools: summary.tools, warnings: summary.warnings.length });
  logger.info("bootstrap: instance self-restored from BOOTSTRAP env", summary);
  return summary;
}
