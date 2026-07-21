import bcrypt from "bcryptjs";
import { z } from "zod";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { sha256Hex } from "./crypto.js";

const SIGNUP = z.object({ email: z.string().email(), password: z.string().min(10, "password must be at least 10 chars") });
const ABSOLUTE_DAYS = 30, IDLE_DAYS = 7;

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

export async function createUser(db, email, password) {
  const parsed = SIGNUP.parse({ email, password });
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(parsed.email);
  if (exists) throw new Error("account already exists");
  const user = { id: crypto.randomUUID(), email: parsed.email.toLowerCase() };
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)")
    .run(user.id, user.email, await hashPassword(parsed.password), new Date().toISOString());
  return user;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  db.prepare("INSERT INTO sessions (token_hash,user_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)")
    .run(sha256Hex(token), userId, now.toISOString(), now.toISOString(),
         new Date(now.getTime() + ABSOLUTE_DAYS * 864e5).toISOString());
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token_hash, s.last_seen_at, s.expires_at, u.id, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(sha256Hex(token));
  if (!row) return null;
  const now = Date.now();
  if (now > Date.parse(row.expires_at) || now > Date.parse(row.last_seen_at) + IDLE_DAYS * 864e5) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(new Date().toISOString(), row.token_hash);
  return { id: row.id, email: row.email };
}

export function csrfCheck(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  return req.get("x-requested-with") === "kb-bridge";
}

export function requireUser(db) {
  return (req, res, next) => {
    const user = sessionUser(db, req.cookies?.sid);
    if (!user) {
      // fetch() follows the redirect and then fails to parse the login HTML as
      // JSON, so the user saw "Something went wrong" instead of the truth.
      if (req.get("x-requested-with") === "kb-bridge") {
        return res.status(401).json({ ok: false, error: "Your session expired - log in again." });
      }
      return res.redirect("/login");
    }
    if (!csrfCheck(req)) return res.status(403).json({ error: "csrf" });
    req.user = user;
    next();
  };
}

export const loginLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true });

export function audit(db, userId, event, detail) {
  db.prepare("INSERT INTO audit_log (ts,user_id,event,detail_json) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), userId ?? null, event, JSON.stringify(detail ?? {}));
}

export function cookieOpts(nodeEnv) {
  return { httpOnly: true, sameSite: "lax", secure: nodeEnv === "production", maxAge: ABSOLUTE_DAYS * 864e5, path: "/" };
}

export function cookieParser(req, _res, next) {
  req.cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
}
