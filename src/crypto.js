import crypto from "node:crypto";

export function newSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function encryptSecret(plain, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptSecret(blob, keyB64) {
  const [v, ivB64, ctB64, tagB64] = String(blob).split(":");
  if (v !== "v1") throw new Error("unknown envelope version");
  const key = Buffer.from(keyB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
