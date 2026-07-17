export function loadConfig(env = process.env) {
  const key = env.ENCRYPTION_KEY || "";
  if (Buffer.from(key, "base64").length !== 32) {
    throw new Error("ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  }
  return {
    port: Number(env.PORT || 3900),
    baseUrl: (env.BASE_URL || "http://localhost:3900").replace(/\/$/, ""),
    dataDir: env.DATA_DIR || "./data",
    encryptionKey: key,
    mockAssistable: env.MOCK_ASSISTABLE !== "0",
    assistableApiBase: env.ASSISTABLE_API_BASE || "https://apiv3.createassistants.com",
    nodeEnv: env.NODE_ENV || "development",
  };
}
