import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Self-host plug-and-play: if no ENCRYPTION_KEY is provided, generate one on
 * first boot and persist it in the data dir so restarts keep decrypting.
 */
export function resolveEncryptionKey(env, dataDir) {
  if (env.ENCRYPTION_KEY) return env.ENCRYPTION_KEY;
  const keyFile = path.join(dataDir, ".encryption-key");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  const key = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

export function loadConfig(env = process.env, { autoKey = false } = {}) {
  const dataDir = env.DATA_DIR || "./data";
  const key = autoKey ? resolveEncryptionKey(env, dataDir) : (env.ENCRYPTION_KEY || "");
  if (Buffer.from(key, "base64").length !== 32) {
    throw new Error("ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  }
  // Render sets RENDER_EXTERNAL_URL; use it so self-hosters need zero URL config.
  const baseUrl = env.BASE_URL || env.RENDER_EXTERNAL_URL || "http://localhost:3900";
  return {
    port: Number(env.PORT || 3900),
    baseUrl: baseUrl.replace(/\/$/, ""),
    dataDir,
    encryptionKey: key,
    // File-based keys die with the disk; backups encrypted under them become
    // unreadable after a wipe. The setup page warns when this is the case.
    encryptionKeyFromEnv: !!env.ENCRYPTION_KEY,
    mockAssistable: env.MOCK_ASSISTABLE !== "0",
    assistableApiBase: env.ASSISTABLE_API_BASE || "https://apiv3.createassistants.com",
    nodeEnv: env.NODE_ENV || "development",
    // 'open' (shared portal) | 'first-only' (self-hosted: first signup claims the instance)
    signups: env.SIGNUPS === "first-only" ? "first-only" : "open",
    // Env vars survive the ephemeral-disk wipe that erases the users table, so
    // this is the one credential that can prove ownership of a fresh instance:
    // when set, the FIRST signup after a wipe must present it.
    setupToken: env.SETUP_TOKEN || null,
  };
}
