# Dynamic KB Portal ("KB Bridge") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-tenant portal where Assistable customers connect live data (website / feed / CSV / Postgres) and their voice+chat agents query it in real time through auto-provisioned custom tools.

**Architecture:** Single Node 22 process: Express web app + in-process sync scheduler + SQLite (WAL) store. Per-source search webhook is what Assistable's tool proxy calls mid-conversation; an Assistable v3 API client provisions the tool into the customer's account. Tool-first (no KB writes — v3-created KB sources never get embedded; verified platform bug).

**Tech Stack:** Plain ESM JavaScript (no TypeScript, no build step). express, better-sqlite3, bcryptjs, zod, helmet, express-rate-limit, cheerio, papaparse, fast-xml-parser, multer, pg, undici. Tests with `node:test` + built-in `fetch`.

## Global Constraints

- Node >= 22; `"type": "module"`; dependencies limited to the list above (Node built-ins preferred).
- All timestamps stored as ISO-8601 UTC strings.
- Every user-scoped DB read goes through the tenant DAL (`ownedSource`/`ownedRow`) — no route handler queries `sources`/`items`/`tools` by bare id.
- Search endpoint: p95 < 300ms target, hard internal deadline 2500ms, **always HTTP 200** for handled outcomes (auth failure = 404 empty body; that's the only non-200).
- Secrets (Assistable API keys, source configs containing DB credentials) are AES-256-GCM encrypted at rest; never logged (logger redacts), never rendered back into HTML.
- Tool JSON-Schema is FLAT and STABLE: top-level `query` + up to 6 generated filter params; `""`/`0` sentinels mean "not specified" (platform forces every declared top-level param to required on both channels).
- Commit after every task with the message given in the task.

## Platform Contract (verified from Assistable source — do not re-derive)

Facts an implementer must code against. Citations are into `Case Study/_assistable-code`.

1. **Who calls us:** Assistable's backend (`executeProxiedTool`) makes the HTTP call for BOTH chat and voice. Voice path: Telnyx → `POST https://api.assistable.ai/internal/tool-proxy/{toolId}` (10s timeout, method always POST on that hop) → our URL using the tool's configured `httpMethod`. Chat calls the same function in-process. (`be/.../services/tool-proxy.service.ts:481-534`, `telnyx-tool-translator.ts:593-627`, `agent-run.ts:345-371`)
2. **Request we receive:** `POST` with `Content-Type: application/json`. Body envelope: `{"args": <LLM tool args>, "meta_data": {tool_id, location_id, contact_id, assistant_id, to, from, direction}, "metadata": <same>, "call": {"call_id": <call_control_id-or-conversation-id>, "retell_llm_dynamic_variables": {}}}`. `executionType` is NOT settable via the v3 API, so we always get the envelope — but parse defensively (accept raw args too). Headers include auto-injected `location_id`, `assistant_id`, `call_control_id`, `direction`, sometimes `contact_id`/`to`/`from` (voice), PLUS our configured tool headers verbatim (`x-bridge-secret`). `contact_id` can be missing (~8-17% of voice calls). (`tool-proxy.service.ts:415-507`)
3. **Timing/retries:** Telnyx gives the whole round trip 10s; the proxy fetch uses 15s × up to 4 attempts and **retries 5xx and 429**. Therefore: answer < 2.5s, never return 5xx/429 for handled errors — return 200 with an error JSON. 4xx (non-429) is not retried; auth failure → 404 empty. (`be/.../lib/http.ts:37-100`)
4. **Response handling:** Chat feeds `JSON.stringify(<parsed body>)` to the LLM untruncated; voice wraps it as `{"return": <parsed body>}`. Keep the body small (≤ ~1200 chars) and self-explanatory; include a `speech_hint` field the voice LLM can read aloud. (`tool-proxy.service.ts:558-618`, `agent-run.ts:434-438`)
5. **Tool provisioning (v3 API):** `POST /v3/tools` body (snake_case): `name` (required, `^[a-zA-Z0-9_-]{1,64}$`, 409 on duplicate per subaccount), `description`, `tool_type` (use `"FUNCTION"`), `url`, `http_method` (`"POST"`), `headers` (flat string map — our secret goes here; stored plaintext in their account), `parameters` (JSON-Schema object), `required_params` (ignore — platform forces all top-level properties required anyway). `PATCH /v3/tools/:id` **fully replaces** headers/parameters child rows — always send complete maps. Assign: `POST /v3/tools/:id/assign` `{assistant_id}`; remove: `/remove`. Assistants list: `GET /v3/assistants` (omit `include_archived` — `z.coerce.boolean` footgun makes `?include_archived=false` truthy). All responses in `{data, error, request_id}` envelope. Rate limits: 150 req/10s + 100k/day per workspace+subaccount; honor 429 `Retry-After`. `timeout`/`executionType`/`channel` are NOT settable (channel doesn't exist — every assistant-linked FUNCTION/CUSTOM tool serves voice AND chat automatically). (`be/.../routes/v3/tools.ts`, `_schemas.ts:615`, `rate-limit-config.service.ts:20-22`)
6. **Voice schema snapshot:** tool name/description/parameters are baked into the Telnyx agent at assistant-save; URL/header changes apply per-call, schema changes need an assistant re-save. Hence the STABLE flat schema; when column vocabulary drifts we update only the description and show a "re-save your assistant to refresh voice" notice. (`telnyx-agent.ts:44`, translator `:878`)
7. **What we're beating (static KB):** chat = raw-message embed → Pinecone top-3, no score floor, ~3KB context; voice = top-6, $0.01/query; CSV ingested as raw text chunks (1000 chars/200 overlap — rows severed, header lost after chunk 1); no re-sync path — re-upload duplicates sources and stale chunks keep answering until manually deleted. (`agent-run.ts:957-999`, `routes/knowledge-base.ts:64-144`, v2 `chunking.service.ts:17`, v2 `knowledge-processor.service.ts:104,347`)

## File Structure

```
assistable-dynamic-kb/
├── package.json, .gitignore, .env.example, README.md
├── src/
│   ├── config.js            # loadConfig() from env, validates ENCRYPTION_KEY
│   ├── logger.js            # JSON-line logger with secret redaction
│   ├── crypto.js            # AES-256-GCM encrypt/decrypt, secrets, constant-time compare
│   ├── db.js                # openDb(), SCHEMA (all DDL incl. FTS5 + triggers)
│   ├── ssrf-guard.js        # assertPublicHttpUrl(), safeFetch() (undici Agent, IP-pinned)
│   ├── auth.js              # password hash, sessions, requireUser, CSRF, login limiter
│   ├── tenant.js            # ownedSource()/ownedConnection() — tenant isolation DAL
│   ├── assistable/
│   │   ├── client.js        # AssistableClient (v3 API, MOCK mode, 429 backoff)
│   │   └── tool-def.js      # buildToolDefinition(source, columnMeta, opts)
│   ├── ingest/
│   │   └── normalize.js     # inferColumnMeta(), parseNumericLike(), rowToItem()
│   ├── connectors/
│   │   ├── feed.js          # JSON/CSV/XML feed URL
│   │   ├── csv.js           # uploaded CSV text
│   │   ├── website.js       # same-origin crawler → heading-chunked text items
│   │   └── database.js      # Postgres SELECT-only, ident-validated
│   ├── sync/
│   │   └── engine.js        # scheduler, runSync, classifyError, swapBatch, backups
│   ├── search/
│   │   ├── normalize.js     # aliases, tokenize, resolveCategorical (edit distance)
│   │   ├── structured.js    # filter mapping + tiered relaxation + alternatives
│   │   ├── text.js          # FTS5/BM25 for website sources
│   │   └── respond.js       # tool response shape incl. speech_hint
│   ├── routes/
│   │   ├── tool-api.js      # POST /api/tools/:sourceId/search
│   │   └── dashboard.js     # signup/login/connect/sources CRUD/sync-now/rollback
│   ├── views/
│   │   └── pages.js         # template-literal HTML (escaped), zero client framework
│   └── server.js            # middleware order, wiring, graceful shutdown
└── test/
    ├── helpers.js           # tmp DB, test server on ephemeral port, fetch helpers
    ├── fixtures/            # inventory.csv, feed.json, feed.xml, site/*.html
    └── *.test.js            # one per module (named in tasks)
```

---

### Task 1: Scaffold, config, logger

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `src/config.js`, `src/logger.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env) -> {port, baseUrl, dataDir, encryptionKey, mockAssistable, assistableApiBase, nodeEnv}`; `createLogger() -> {info(msg, fields), warn, error}` (JSON lines to stdout, redacts keys matching `/key|secret|password|token|authorization|connection/i`).

- [ ] **Step 1: Write package.json + .gitignore + .env.example**

```json
{
  "name": "assistable-dynamic-kb",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "express": "^4.21.0",
    "better-sqlite3": "^11.5.0",
    "bcryptjs": "^3.0.2",
    "zod": "^3.24.0",
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.4.0",
    "cheerio": "^1.0.0",
    "papaparse": "^5.4.1",
    "fast-xml-parser": "^4.5.0",
    "multer": "^1.4.5-lts.1",
    "pg": "^8.13.0",
    "undici": "^6.21.0"
  }
}
```

`.gitignore`: `node_modules/`, `.env`, `data/`, `*.db`, `backups/`
`.env.example`:

```
PORT=3900
BASE_URL=http://localhost:3900          # public URL Assistable will call
DATA_DIR=./data
ENCRYPTION_KEY=                          # base64 of 32 random bytes: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
MOCK_ASSISTABLE=1                        # 1 = log v3 calls instead of sending
ASSISTABLE_API_BASE=https://apiv3.createassistants.com
NODE_ENV=development
```

- [ ] **Step 2: Write the failing test**

```js
// test/config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

test("loadConfig validates and defaults", () => {
  const c = loadConfig({ ENCRYPTION_KEY: KEY, BASE_URL: "https://kb.example.com" });
  assert.equal(c.port, 3900);
  assert.equal(c.mockAssistable, true);
  assert.equal(c.baseUrl, "https://kb.example.com");
});

test("loadConfig rejects bad key", () => {
  assert.throws(() => loadConfig({ ENCRYPTION_KEY: "short" }), /ENCRYPTION_KEY/);
});

test("logger redacts secrets", () => {
  const lines = [];
  const log = createLogger({ write: (s) => lines.push(s) });
  log.info("x", { api_key: "sk-123", email: "a@b.c", authorization: "Bearer y" });
  const out = JSON.parse(lines[0]);
  assert.equal(out.api_key, "[redacted]");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.email, "a@b.c");
});
```

- [ ] **Step 3: Run test to verify it fails** — `node --test test/config.test.js` → FAIL (module not found).

- [ ] **Step 4: Implement**

```js
// src/config.js
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
```

```js
// src/logger.js
const REDACT = /key|secret|password|token|authorization|connection/i;

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = REDACT.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function createLogger({ write = (s) => process.stdout.write(s + "\n") } = {}) {
  const emit = (level, msg, fields) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) }));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
```

- [ ] **Step 5: Run tests** — `npm install && node --test test/config.test.js` → PASS (3/3).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: scaffold, config, redacting logger"`

---

### Task 2: Crypto (secrets at rest)

**Files:**
- Create: `src/crypto.js`
- Test: `test/crypto.test.js`

**Interfaces:**
- Produces: `encryptSecret(plain, keyB64) -> "v1:<ivB64>:<ctB64>:<tagB64>"`; `decryptSecret(blob, keyB64) -> string` (throws on tamper); `newSecret(bytes=32) -> base64url string`; `constantTimeEqual(a, b) -> boolean`; `sha256Hex(s) -> string`.

- [ ] **Step 1: Write the failing test**

```js
// test/crypto.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, newSecret, constantTimeEqual, sha256Hex } from "../src/crypto.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

test("round trip", () => {
  const blob = encryptSecret("sk-live-abc", KEY);
  assert.match(blob, /^v1:/);
  assert.equal(decryptSecret(blob, KEY), "sk-live-abc");
});

test("unique IVs", () => {
  assert.notEqual(encryptSecret("x", KEY), encryptSecret("x", KEY));
});

test("tamper detection", () => {
  const parts = encryptSecret("x", KEY).split(":");
  parts[2] = Buffer.from("evil").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":"), KEY));
});

test("constantTimeEqual handles length mismatch without throwing", () => {
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("same", "same"), true);
});

test("newSecret is 43 chars base64url and unique", () => {
  const s = newSecret();
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(s, newSecret());
});

test("sha256Hex", () => {
  assert.equal(sha256Hex("a").length, 64);
});
```

- [ ] **Step 2: Run to fail** — `node --test test/crypto.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
// src/crypto.js
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
```

- [ ] **Step 4: Run tests** — PASS (6/6).
- [ ] **Step 5: Commit** — `git commit -am "feat: AES-256-GCM secret envelope + constant-time compare"`

---

### Task 3: Database schema

**Files:**
- Create: `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `openDb(filePath) -> better-sqlite3 Database` (applies pragmas: WAL, busy_timeout 5000, synchronous NORMAL, foreign_keys ON; runs SCHEMA idempotently). Table/column names below are canonical for every later task.

- [ ] **Step 1: Write the failing test**

```js
// test/db.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

test("schema creates all tables and FTS stays in sync", () => {
  const db = openDb(":memory:");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ["users","sessions","connections","sources","items","sync_runs","tools","tool_calls","audit_log"]) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,schedule_minutes,secret,status,created_at)
              VALUES ('s1','u1','csv','inv','ct',1440,'sec','never_synced','2026-01-01')`).run();
  db.prepare(`INSERT INTO items (id,source_id,batch_id,title,body,structured_json)
              VALUES ('i1','s1','b1','2022 Toyota Tacoma','2022 Toyota Tacoma SR5 28500','{}')`).run();
  const hit = db.prepare(`SELECT rowid FROM items_fts WHERE items_fts MATCH 'tacoma'`).all();
  assert.equal(hit.length, 1);
  db.prepare(`DELETE FROM items WHERE id='i1'`).run();
  assert.equal(db.prepare(`SELECT count(*) c FROM items_fts WHERE items_fts MATCH 'tacoma'`).get().c, 0);
});

test("openDb is idempotent", () => {
  const db = openDb(":memory:");
  assert.ok(db.pragma("journal_mode", { simple: true }) !== undefined);
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/db.js
import Database from "better-sqlite3";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key_ct TEXT NOT NULL, label TEXT, status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('website','feed','csv','database')),
  name TEXT NOT NULL, config_ct TEXT NOT NULL,
  schedule_minutes INTEGER NOT NULL DEFAULT 1440,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'never_synced'
    CHECK (status IN ('never_synced','syncing','active','stale','error')),
  active_batch_id TEXT, prev_batch_id TEXT,
  column_meta_json TEXT NOT NULL DEFAULT '[]',
  last_sync_at TEXT, next_run_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources (next_run_at) WHERE status != 'syncing';
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  structured_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_items_source_batch ON items (source_id, batch_id);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, content='items', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  batch_id TEXT, started_at TEXT NOT NULL, heartbeat_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  items_count INTEGER, error TEXT, manual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs (source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS tools (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  tool_id TEXT, assistant_ids_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL,
  ts TEXT NOT NULL, args_json TEXT NOT NULL, result_count INTEGER,
  relaxations TEXT, took_ms INTEGER, ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_source ON tool_calls (source_id, ts DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  user_id TEXT, event TEXT NOT NULL, detail_json TEXT
);
`;

export function openDb(filePath) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: sqlite schema with FTS5 and batch model"`

---

### Task 4: SSRF guard + safeFetch

**Files:**
- Create: `src/ssrf-guard.js`
- Test: `test/ssrf-guard.test.js`

**Interfaces:**
- Produces: `isPrivateIp(ip) -> boolean`; `assertPublicHttpUrl(urlStr, {lookupFn}) -> Promise<URL>` (throws `Error` with `.code="SSRF_BLOCKED"`); `safeFetch(urlStr, {timeoutMs=15000, maxBytes=10_485_760, maxRedirects=4, headers, lookupFn}) -> Promise<{status, headers, text}>`. Uses an undici `Agent` whose `connect.lookup` re-validates the IP at connect time (closes DNS-rebinding TOCTOU). Ports allowed: 80, 443, 8080, 8443.

- [ ] **Step 1: Write the failing test**

```js
// test/ssrf-guard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateIp, assertPublicHttpUrl, safeFetch } from "../src/ssrf-guard.js";

test("isPrivateIp classification", () => {
  for (const ip of ["127.0.0.1","10.1.2.3","172.16.0.1","172.31.255.255","192.168.1.1","169.254.169.254","0.0.0.0","100.64.0.1","::1","fe80::1","fd00::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8","1.1.1.1","172.32.0.1","2606:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("assertPublicHttpUrl blocks schemes, ports, private DNS", async () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const priv = async () => [{ address: "192.168.0.10", family: 4 }];
  await assert.rejects(assertPublicHttpUrl("ftp://x.com", { lookupFn: pub }), /SSRF|scheme/i);
  await assert.rejects(assertPublicHttpUrl("http://x.com:22/", { lookupFn: pub }), /port/i);
  await assert.rejects(assertPublicHttpUrl("http://internal.corp/", { lookupFn: priv }), /private/i);
  await assert.doesNotReject(assertPublicHttpUrl("https://example.com/feed.json", { lookupFn: pub }));
});

test("safeFetch caps response size", async () => {
  const srv = http.createServer((req, res) => { res.end("x".repeat(2000)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  // loopback allowed only via explicit test lookupFn override
  const loop = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(
    safeFetch(`http://localtest:${port}/`, { maxBytes: 100, lookupFn: loop, allowPrivateForTest: true, allowedPorts: [port] }),
    /size/i
  );
  srv.close();
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/ssrf-guard.js
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip) {
  return ip.split(".").reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n);
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >> BigInt(32 - bits)) === (v4ToInt(base) >> BigInt(32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
    return false;
  }
  return true; // unparseable → treat as unsafe
}

const DEFAULT_PORTS = [80, 443, 8080, 8443];

export async function assertPublicHttpUrl(urlStr, { lookupFn, allowedPorts = DEFAULT_PORTS, allowPrivateForTest = false } = {}) {
  let url;
  try { url = new URL(urlStr); } catch { const e = new Error("invalid URL"); e.code = "SSRF_BLOCKED"; throw e; }
  if (!["http:", "https:"].includes(url.protocol)) {
    const e = new Error("SSRF blocked: scheme not allowed"); e.code = "SSRF_BLOCKED"; throw e;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!allowedPorts.includes(port)) {
    const e = new Error(`SSRF blocked: port ${port} not allowed`); e.code = "SSRF_BLOCKED"; throw e;
  }
  const resolve = lookupFn || ((h) => dnsLookup(h, { all: true }));
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await resolve(url.hostname);
  if (!allowPrivateForTest && addrs.some((a) => isPrivateIp(a.address))) {
    const e = new Error("SSRF blocked: resolves to private address"); e.code = "SSRF_BLOCKED"; throw e;
  }
  return url;
}

export async function safeFetch(urlStr, opts = {}) {
  const { timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024, maxRedirects = 4, headers = {} } = opts;
  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current, opts);
    // pin validation at connect time too (anti-rebinding)
    const agent = new Agent({
      connect: {
        lookup: (hostname, o, cb) => {
          const resolve = opts.lookupFn || ((h) => dnsLookup(h, { all: true }));
          resolve(hostname).then((addrs) => {
            const bad = !opts.allowPrivateForTest && addrs.some((a) => isPrivateIp(a.address));
            if (bad || addrs.length === 0) return cb(new Error("SSRF blocked at connect"));
            cb(null, addrs[0].address, addrs[0].family || (net.isIPv6(addrs[0].address) ? 6 : 4));
          }, cb);
        },
      },
    });
    const res = await fetch(current, {
      headers, redirect: "manual", dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect without location");
      current = new URL(loc, current).href;
      continue;
    }
    const reader = res.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error(`response size exceeds ${maxBytes} bytes`); }
        chunks.push(value);
      }
    }
    return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("too many redirects");
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: SSRF guard with connect-time IP pinning and size caps"`

---

### Task 5: Auth, sessions, CSRF, tenant DAL

**Files:**
- Create: `src/auth.js`, `src/tenant.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Produces (auth.js): `hashPassword(pw) -> Promise<hash>` / `verifyPassword(pw, hash) -> Promise<boolean>` (bcryptjs cost 12); `createUser(db, email, pw) -> user` (zod: email, pw ≥ 10 chars); `createSession(db, userId) -> token` (32B random; sha256 stored; absolute expiry 30d); `requireUser(db) -> express middleware` (reads `sid` cookie, sliding idle window 7d, sets `req.user`, else 302 `/login`); `csrfProtect` middleware (mutating requests must carry header `x-requested-with: kb-bridge`; else 403 — dashboard JS always uses `fetch` with that header; cookies are `SameSite=Lax`, so cross-site POSTs can't add custom headers); `loginLimiter` (express-rate-limit, 10/10min per IP) ; `audit(db, userId, event, detail)`.
- Produces (tenant.js): `ownedSource(db, userId, sourceId) -> row|null`; `ownedConnection(db, userId) -> row|null`. **Every later task uses these — never query sources by bare id in a route.**

- [ ] **Step 1: Write the failing test**

```js
// test/auth.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { hashPassword, verifyPassword, createUser, createSession, sessionUser, csrfCheck } from "../src/auth.js";
import { ownedSource } from "../src/tenant.js";

test("password hash + verify", async () => {
  const h = await hashPassword("hunter2hunter2");
  assert.ok(h.startsWith("$2"));
  assert.equal(await verifyPassword("hunter2hunter2", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
});

test("signup validation", async () => {
  const db = openDb(":memory:");
  await assert.rejects(createUser(db, "notanemail", "longenough1"), /email/i);
  await assert.rejects(createUser(db, "a@b.co", "short"), /10/);
  const u = await createUser(db, "a@b.co", "longenough1");
  await assert.rejects(createUser(db, "A@B.CO", "longenough1"), /exists/i);
  assert.ok(u.id);
});

test("session create/resolve/expiry", async () => {
  const db = openDb(":memory:");
  const u = await createUser(db, "a@b.co", "longenough1");
  const token = createSession(db, u.id);
  assert.equal(sessionUser(db, token).id, u.id);
  assert.equal(sessionUser(db, "bogus"), null);
  db.prepare("UPDATE sessions SET expires_at='2020-01-01T00:00:00Z'").run();
  assert.equal(sessionUser(db, token), null);
});

test("csrfCheck requires custom header on mutations", () => {
  assert.equal(csrfCheck({ method: "GET", get: () => undefined }), true);
  assert.equal(csrfCheck({ method: "POST", get: () => undefined }), false);
  assert.equal(csrfCheck({ method: "POST", get: (h) => h === "x-requested-with" ? "kb-bridge" : undefined }), true);
});

test("tenant isolation: ownedSource", async () => {
  const db = openDb(":memory:");
  const u1 = await createUser(db, "a@b.co", "longenough1");
  const u2 = await createUser(db, "c@d.co", "longenough1");
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES ('s1',?,'csv','inv','ct','sec','2026-01-01')`).run(u1.id);
  assert.ok(ownedSource(db, u1.id, "s1"));
  assert.equal(ownedSource(db, u2.id, "s1"), null); // IDOR blocked
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/auth.js
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
    if (!user) return res.redirect("/login");
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
```

```js
// src/tenant.js
export function ownedSource(db, userId, sourceId) {
  return db.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?").get(sourceId, userId) ?? null;
}
export function ownedConnection(db, userId) {
  return db.prepare("SELECT * FROM connections WHERE user_id = ?").get(userId) ?? null;
}
```

Note: `requireUser` reads `req.cookies` — Task 12 wires a 15-line cookie parser (no dep) into the app; for tests call `sessionUser` directly.

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: auth, hashed sessions, csrf, tenant isolation DAL"`

---

### Task 6: Ingest normalization + column inference

**Files:**
- Create: `src/ingest/normalize.js`
- Test: `test/normalize.test.js`

**Interfaces:**
- Produces: `parseNumericLike(v) -> number|null` (`"$24,995"→24995`, `"12k"→12000`, `"28,500 km"→28500`, `"N/A"→null`); `inferColumnMeta(rows) -> [{name, kind: 'numeric'|'categorical'|'text', distincts?: string[], min?, max?}]` (numeric if ≥90% of non-empty values parse; categorical if distinct count ≤ max(25, 5% of rows); distincts stored for categorical only, capped 25); `rowToItem(row, columns) -> {title, body, structured}` (title = first 2 text/categorical + numeric-year-ish values joined; body = all values joined for FTS).

- [ ] **Step 1: Write the failing test**

```js
// test/normalize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericLike, inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";

test("parseNumericLike", () => {
  assert.equal(parseNumericLike("$24,995"), 24995);
  assert.equal(parseNumericLike("12k"), 12000);
  assert.equal(parseNumericLike("28,500 km"), 28500);
  assert.equal(parseNumericLike("2022"), 2022);
  assert.equal(parseNumericLike("N/A"), null);
  assert.equal(parseNumericLike(""), null);
  assert.equal(parseNumericLike("SR5"), null);
});

const rows = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "V1" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", vin: "V2" },
  { make: "Honda",  model: "Civic",  year: "2021", price: "$19,900", vin: "V3" },
];

test("inferColumnMeta kinds", () => {
  const meta = inferColumnMeta(rows);
  const by = Object.fromEntries(meta.map(c => [c.name, c]));
  assert.equal(by.year.kind, "numeric");
  assert.equal(by.price.kind, "numeric");
  assert.equal(by.price.min, 19900);
  assert.equal(by.price.max, 41000);
  assert.equal(by.make.kind, "categorical");
  assert.deepEqual(by.make.distincts.sort(), ["Honda", "Toyota"]);
});

test("rowToItem builds searchable text + typed structured values", () => {
  const meta = inferColumnMeta(rows);
  const item = rowToItem(rows[0], meta);
  assert.match(item.title, /Toyota/);
  assert.match(item.body, /Tacoma/);
  assert.equal(item.structured.price, 28500);   // numeric coerced
  assert.equal(item.structured.make, "Toyota");
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/ingest/normalize.js
export function parseNumericLike(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || /^(n\/a|na|null|-|none)$/.test(s)) return null;
  let mult = 1;
  if (/^\$?[\d,.]+\s*k$/.test(s)) { mult = 1000; s = s.replace(/k$/, ""); }
  s = s.replace(/[$,\s]/g, "").replace(/(km|mi|miles|kms)$/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * mult;
}

export function inferColumnMeta(rows) {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  return names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const nums = vals.map(parseNumericLike).filter((n) => n !== null);
    if (vals.length > 0 && nums.length >= vals.length * 0.9) {
      return { name, kind: "numeric", min: Math.min(...nums), max: Math.max(...nums) };
    }
    const distinct = [...new Set(vals.map((v) => String(v).trim()))];
    if (distinct.length <= Math.max(25, rows.length * 0.05) && distinct.length <= 25) {
      return { name, kind: "categorical", distincts: distinct };
    }
    return { name, kind: "text" };
  });
}

export function rowToItem(row, columns) {
  const structured = {};
  for (const col of columns) {
    const raw = row[col.name];
    structured[col.name] = col.kind === "numeric" ? parseNumericLike(raw) : (raw === undefined || raw === null ? null : String(raw).trim());
  }
  const titleParts = [];
  const yearish = columns.find((c) => c.kind === "numeric" && /year/i.test(c.name));
  if (yearish && structured[yearish.name] != null) titleParts.push(structured[yearish.name]);
  for (const c of columns) {
    if (titleParts.length >= 3) break;
    if (c.kind !== "numeric" && structured[c.name]) titleParts.push(structured[c.name]);
  }
  const body = columns.map((c) => structured[c.name]).filter((v) => v !== null && v !== "").join(" ");
  return { title: titleParts.join(" "), body, structured };
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: numeric parsing, column inference, row->item mapping"`

---

### Task 7: Feed + CSV connectors

**Files:**
- Create: `src/connectors/feed.js`, `src/connectors/csv.js`, `test/fixtures/inventory.csv`, `test/fixtures/feed.json`, `test/fixtures/feed.xml`
- Test: `test/connectors-feed.test.js`

**Interfaces:**
- Consumes: `safeFetch` (Task 4), `inferColumnMeta`/`rowToItem` (Task 6).
- Produces: `parseCsvItems(text) -> {rows}` ; `fetchFeedItems(config, {fetchImpl}) -> {rows}` where `config = {url, format?: 'json'|'csv'|'xml'|'auto', authHeader?: {name, value}}`. Rows are arrays of flat objects; the sync engine (Task 9) applies inference + rowToItem. JSON: accepts top-level array or first array value found at any of `data`,`items`,`products`,`inventory`,`results`, else first array-typed property. XML: `fast-xml-parser`, then same array-finding rule.

- [ ] **Step 1: Create fixtures**

`test/fixtures/inventory.csv`:
```csv
make,model,year,price,mileage,vin,color,status
Toyota,Tacoma,2022,"$28,500",31000,VIN001,Silver,available
Toyota,Tacoma,2021,"$26,900",44000,VIN002,Red,available
Toyota,Tundra,2023,"$41,000",12000,VIN003,Black,available
Honda,Civic,2021,"$19,900",38000,VIN004,White,available
Chevrolet,Silverado,2022,"$36,750",25500,VIN005,Blue,pending
```

`test/fixtures/feed.json`: `{"data":[{"sku":"H-BLK-M","name":"Classic Hoodie","color":"Black","size":"M","price":"49.00","stock":"12"},{"sku":"H-BLK-L","name":"Classic Hoodie","color":"Black","size":"L","price":"49.00","stock":"0"}]}`

`test/fixtures/feed.xml`: `<catalog><item><sku>A1</sku><name>Widget</name><price>9.99</price></item><item><sku>A2</sku><name>Gadget</name><price>19.99</price></item></catalog>`

- [ ] **Step 2: Write the failing test**

```js
// test/connectors-feed.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsvItems } from "../src/connectors/csv.js";
import { fetchFeedItems } from "../src/connectors/feed.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("csv parses with quoted currency", () => {
  const { rows } = parseCsvItems(fx("inventory.csv"));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].price, "$28,500");
});

test("feed json finds nested array", async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Map([["content-type", "application/json"]]), text: fx("feed.json") });
  const { rows } = await fetchFeedItems({ url: "https://x.com/feed", format: "auto" }, { fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sku, "H-BLK-M");
});

test("feed xml", async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Map([["content-type", "text/xml"]]), text: fx("feed.xml") });
  const { rows } = await fetchFeedItems({ url: "https://x.com/feed.xml", format: "xml" }, { fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, "Gadget");
});

test("feed non-200 throws permanent error", async () => {
  const fetchImpl = async () => ({ status: 403, headers: new Map(), text: "no" });
  await assert.rejects(fetchFeedItems({ url: "https://x.com/f" }, { fetchImpl }), (e) => e.permanent === true);
});
```

- [ ] **Step 3: Run to fail.**

- [ ] **Step 4: Implement**

```js
// src/connectors/csv.js
import Papa from "papaparse";

export function parseCsvItems(text) {
  const parsed = Papa.parse(String(text).trim(), { header: true, skipEmptyLines: true });
  if (parsed.errors.some((e) => e.type === "Delimiter")) {
    const err = new Error("could not parse CSV"); err.permanent = true; throw err;
  }
  return { rows: parsed.data };
}
```

```js
// src/connectors/feed.js
import { XMLParser } from "fast-xml-parser";
import { safeFetch } from "../ssrf-guard.js";
import { parseCsvItems } from "./csv.js";

const ARRAY_KEYS = ["data", "items", "products", "inventory", "results", "vehicles", "rows"];

function findArray(node) {
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    for (const k of ARRAY_KEYS) if (Array.isArray(node[k])) return node[k];
    for (const v of Object.values(node)) {
      const found = findArray(v);
      if (found) return found;
    }
  }
  return null;
}

export async function fetchFeedItems(config, { fetchImpl = safeFetch } = {}) {
  const headers = config.authHeader?.name ? { [config.authHeader.name]: config.authHeader.value } : {};
  const res = await fetchImpl(config.url, { headers, maxBytes: 20 * 1024 * 1024 });
  if (res.status !== 200) {
    const err = new Error(`feed returned HTTP ${res.status}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  const ct = (typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
  const format = config.format && config.format !== "auto" ? config.format
    : ct.includes("json") ? "json" : ct.includes("xml") ? "xml" : ct.includes("csv") ? "csv"
    : res.text.trim().startsWith("{") || res.text.trim().startsWith("[") ? "json"
    : res.text.trim().startsWith("<") ? "xml" : "csv";
  let rows;
  if (format === "json") rows = findArray(JSON.parse(res.text));
  else if (format === "xml") rows = findArray(new XMLParser({ ignoreAttributes: false }).parse(res.text));
  else rows = parseCsvItems(res.text).rows;
  if (!rows || !rows.length) { const e = new Error("no rows found in feed"); e.permanent = true; throw e; }
  return { rows: rows.map((r) => flatten(r)) };
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
```

- [ ] **Step 5: Run tests** — PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: feed url + csv connectors"`

---

### Task 8: Website + database connectors

**Files:**
- Create: `src/connectors/website.js`, `src/connectors/database.js`, `test/fixtures/site-home.html`, `test/fixtures/site-specials.html`
- Test: `test/connectors-web-db.test.js`

**Interfaces:**
- Consumes: `safeFetch` (Task 4).
- Produces: `crawlSiteItems(config, {fetchImpl}) -> {rows}` where `config = {url, maxPages=50, maxDepth=3}`; each row = `{page_url, heading, content}` (unstructured — heading-path chunks of ~1500 chars from main text, nav/script/style stripped, same-origin BFS, robots.txt `Disallow` for `*` respected, 300ms polite delay skipped when `fetchImpl` injected). `fetchDbItems(config) -> {rows}` where `config = {connectionString, table}`; validates `table` against `/^[a-zA-Z_][a-zA-Z0-9_.]{0,62}$/`, runs `SELECT * FROM <table> LIMIT 20000` with `statement_timeout 5000`, TLS `rejectUnauthorized:false` fallback allowed; `{pgClientFactory}` injectable for tests.

- [ ] **Step 1: Create fixtures**

`test/fixtures/site-home.html`:
```html
<html><body><nav><a href="/specials">Specials</a></nav>
<h1>Riverside Motors</h1><p>Family dealership since 1987. Open Mon-Sat 9-6.</p>
<h2>Service Department</h2><p>Oil changes from $39. Book online or call.</p>
<a href="/specials">See specials</a><a href="https://other.example.com/x">ext</a></body></html>
```

`test/fixtures/site-specials.html`:
```html
<html><body><h1>Current Specials</h1><p>0.9% APR on certified pre-owned Toyotas through July.</p></body></html>
```

- [ ] **Step 2: Write the failing test**

```js
// test/connectors-web-db.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crawlSiteItems } from "../src/connectors/website.js";
import { fetchDbItems } from "../src/connectors/database.js";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("crawler: same-origin BFS, heading chunks, external links ignored", async () => {
  const pages = {
    "https://dealer.example.com/": fx("site-home.html"),
    "https://dealer.example.com/specials": fx("site-specials.html"),
    "https://dealer.example.com/robots.txt": "User-agent: *\nDisallow: /admin",
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    return pages[url] !== undefined
      ? { status: 200, headers: new Map([["content-type", "text/html"]]), text: pages[url] }
      : { status: 404, headers: new Map(), text: "" };
  };
  const { rows } = await crawlSiteItems({ url: "https://dealer.example.com/" }, { fetchImpl });
  assert.ok(rows.some((r) => /0\.9% APR/.test(r.content)));
  assert.ok(rows.some((r) => r.heading.includes("Service Department")));
  assert.ok(!fetched.some((u) => u.includes("other.example.com")));
});

test("crawler respects robots Disallow", async () => {
  const fetchImpl = async (url) => url.endsWith("robots.txt")
    ? { status: 200, headers: new Map(), text: "User-agent: *\nDisallow: /" }
    : { status: 200, headers: new Map([["content-type", "text/html"]]), text: "<h1>x</h1>" };
  await assert.rejects(crawlSiteItems({ url: "https://x.example.com/" }, { fetchImpl }), /robots/i);
});

test("db connector: ident validation + SELECT-only template", async () => {
  await assert.rejects(fetchDbItems({ connectionString: "postgres://x", table: "cars; DROP TABLE users" }), /table name/i);
  const queries = [];
  const pgClientFactory = () => ({
    connect: async () => {},
    query: async (q) => { queries.push(q); return { rows: [{ id: 1, model: "Tacoma" }] }; },
    end: async () => {},
  });
  const { rows } = await fetchDbItems({ connectionString: "postgres://x", table: "public.inventory" }, { pgClientFactory });
  assert.equal(rows[0].model, "Tacoma");
  assert.ok(queries.some((q) => /SET statement_timeout = 5000/.test(q)));
  assert.ok(queries.some((q) => q === 'SELECT * FROM public.inventory LIMIT 20000'));
});
```

- [ ] **Step 3: Run to fail.**

- [ ] **Step 4: Implement**

```js
// src/connectors/website.js
import * as cheerio from "cheerio";
import { safeFetch } from "../ssrf-guard.js";

const CHUNK_TARGET = 1500;

function parseRobots(text) {
  const lines = String(text).split("\n").map((l) => l.trim());
  const dis = [];
  let applies = false;
  for (const l of lines) {
    const ua = l.match(/^user-agent:\s*(.+)$/i);
    if (ua) { applies = ua[1].trim() === "*"; continue; }
    const d = l.match(/^disallow:\s*(.*)$/i);
    if (applies && d) dis.push(d[1].trim());
  }
  return dis;
}

function pageChunks(url, html) {
  const $ = cheerio.load(html);
  $("script,style,nav,footer,header,noscript,iframe").remove();
  const chunks = [];
  let heading = $("title").text().trim() || url;
  let buf = [];
  const flush = () => {
    const content = buf.join(" ").replace(/\s+/g, " ").trim();
    if (content) {
      for (let i = 0; i < content.length; i += CHUNK_TARGET) {
        chunks.push({ page_url: url, heading, content: content.slice(i, i + CHUNK_TARGET) });
      }
    }
    buf = [];
  };
  $("body").find("h1,h2,h3,p,li,td,th").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (["h1", "h2", "h3"].includes(tag)) { flush(); heading = text; }
    else buf.push(text);
  });
  flush();
  return chunks;
}

export async function crawlSiteItems(config, { fetchImpl = safeFetch, delayMs } = {}) {
  const { url, maxPages = 50, maxDepth = 3 } = config;
  const origin = new URL(url).origin;
  let disallow = [];
  try {
    const robots = await fetchImpl(`${origin}/robots.txt`, {});
    if (robots.status === 200) disallow = parseRobots(robots.text);
  } catch { /* no robots -> allowed */ }
  const blocked = (path) => disallow.some((d) => d !== "" && path.startsWith(d));
  if (blocked(new URL(url).pathname) || disallow.includes("/")) {
    const e = new Error("crawl blocked by robots.txt"); e.permanent = true; throw e;
  }
  const seen = new Set();
  const queue = [{ href: url, depth: 0 }];
  const rows = [];
  while (queue.length && seen.size < maxPages) {
    const { href, depth } = queue.shift();
    const norm = href.split("#")[0];
    if (seen.has(norm) || blocked(new URL(norm).pathname)) continue;
    seen.add(norm);
    let res;
    try { res = await fetchImpl(norm, {}); } catch { continue; }
    if (res.status !== 200) continue;
    rows.push(...pageChunks(norm, res.text));
    if (depth < maxDepth) {
      const $ = cheerio.load(res.text);
      $("a[href]").each((_, a) => {
        try {
          const next = new URL($(a).attr("href"), norm);
          if (next.origin === origin) queue.push({ href: next.href, depth: depth + 1 });
        } catch { /* bad href */ }
      });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!rows.length) { const e = new Error("no content extracted from site"); e.permanent = true; throw e; }
  return { rows };
}
```

```js
// src/connectors/database.js
import pg from "pg";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_.]{0,62}$/;

export async function fetchDbItems(config, { pgClientFactory } = {}) {
  if (!IDENT.test(config.table || "")) {
    const e = new Error("invalid table name"); e.permanent = true; throw e;
  }
  const factory = pgClientFactory || (() => new pg.Client({
    connectionString: config.connectionString,
    ssl: config.connectionString?.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  }));
  const client = factory();
  try {
    await client.connect();
    await client.query("SET statement_timeout = 5000");
    const res = await client.query(`SELECT * FROM ${config.table} LIMIT 20000`);
    if (!res.rows.length) { const e = new Error("table returned no rows"); e.permanent = true; throw e; }
    return { rows: res.rows.map((r) => ({ ...r })) };
  } finally {
    await client.end().catch(() => {});
  }
}
```

- [ ] **Step 5: Run tests** — PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: website crawler + read-only postgres connector"`

---

### Task 9: Sync engine (scheduler, retries, atomic swap, crash recovery, backups)

**Files:**
- Create: `src/sync/engine.js`
- Test: `test/sync-engine.test.js`

**Interfaces:**
- Consumes: connectors (Tasks 7-8), `inferColumnMeta`/`rowToItem` (Task 6), `decryptSecret` (Task 2).
- Produces:
  - `runSync(deps, sourceId, {manual=false, force=false}) -> {ok, runId, itemsCount?, error?}` — deps = `{db, config, logger, connectors}` where `connectors = {feed, csv, website, database}` maps type → `async (cfg) => {rows}`.
  - `startScheduler(deps, {tickMs=30_000}) -> {stop()}` — picks due sources (`next_run_at <= now AND status != 'syncing'`), max 2 concurrent, jitter ±10% on next_run_at; daily backup at first tick after 03:00 local (`VACUUM INTO` `${dataDir}/backups/kb-YYYY-MM-DD.db`, keep 7).
  - `classifyError(err) -> 'permanent'|'transient'` (`err.permanent===true` or message matches `/SSRF|parse|invalid|robots|table name|HTTP 4\d\d(?<!429)/` → permanent; else transient).
  - `recoverStuckRuns(db)` — on boot: any `sync_runs.status='running'` with `heartbeat_at` older than 120s → `failed`, source status recomputed.
  - Retry ladder for transient failures: next_run_at += 1min, 5min, 15min by `consecutive_failures`; ≥3 failures → source `stale` (still serving last good batch). Permanent → `error` immediately, no auto-retry.
  - Swap gate inside `runSync`: reject (run `failed`, keep old batch) when `newCount < 1`, or (`oldCount > 0` and `newCount < 0.3*oldCount` and not `force`). On success (single transaction): `prev_batch_id = active_batch_id`, `active_batch_id = newBatch`, `column_meta_json` updated, items of batches older than new `prev_batch_id` deleted, source `active`, `consecutive_failures=0`, `next_run_at = now + schedule ± jitter`.
  - `rollbackSource(db, sourceId)` — swaps active/prev back (only if prev exists), marks latest run `rolled_back`.

- [ ] **Step 1: Write the failing test**

```js
// test/sync-engine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { runSync, classifyError, recoverStuckRuns, rollbackSource } from "../src/sync/engine.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const noopLog = { info() {}, warn() {}, error() {} };

function mkDeps(db, rowsOrFn) {
  return {
    db, logger: noopLog,
    config: { encryptionKey: KEY, dataDir: "./data" },
    connectors: { csv: async () => (typeof rowsOrFn === "function" ? rowsOrFn() : { rows: rowsOrFn }) },
  };
}

function mkSource(db, id = "s1") {
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES (?,'u1','csv','inv',?,'sec','2026-01-01')`).run(id, encryptSecret(JSON.stringify({}), KEY));
}

const ROWS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900" },
];

test("successful sync swaps batch and infers columns", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  const r = await runSync(mkDeps(db, ROWS), "s1", {});
  assert.equal(r.ok, true);
  const src = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  assert.equal(src.status, "active");
  assert.ok(src.active_batch_id);
  assert.equal(db.prepare("SELECT count(*) c FROM items WHERE source_id='s1' AND batch_id=?").get(src.active_batch_id).c, 2);
  const meta = JSON.parse(src.column_meta_json);
  assert.ok(meta.find((c) => c.name === "price" && c.kind === "numeric"));
});

test("shrink gate: refuses swap when new batch < 30% of old", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  const before = db.prepare("SELECT active_batch_id FROM sources WHERE id='s1'").get().active_batch_id;
  const r = await runSync(mkDeps(db, []), "s1", {});   // empty fetch (0 rows -> connector throws or 0 -> gate)
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT active_batch_id FROM sources WHERE id='s1'").get().active_batch_id, before);
});

test("transient failure ladder marks stale after 3", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  const failing = mkDeps(db, () => { throw new Error("ECONNRESET"); });
  await runSync(failing, "s1", {}); await runSync(failing, "s1", {}); await runSync(failing, "s1", {});
  const src = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
  assert.equal(src.status, "stale");
  assert.equal(src.consecutive_failures, 3);
  assert.ok(src.active_batch_id, "old batch still serving");
});

test("classifyError", () => {
  const p = new Error("x"); p.permanent = true;
  assert.equal(classifyError(p), "permanent");
  assert.equal(classifyError(new Error("feed returned HTTP 403")), "permanent");
  assert.equal(classifyError(new Error("feed returned HTTP 429")), "transient");
  assert.equal(classifyError(new Error("ETIMEDOUT")), "transient");
});

test("crash recovery marks stuck running syncs failed", () => {
  const db = openDb(":memory:");
  mkSource(db);
  db.prepare(`INSERT INTO sync_runs (id,source_id,started_at,heartbeat_at,status)
              VALUES ('r1','s1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','running')`).run();
  db.prepare("UPDATE sources SET status='syncing' WHERE id='s1'").run();
  recoverStuckRuns(db);
  assert.equal(db.prepare("SELECT status FROM sync_runs WHERE id='r1'").get().status, "failed");
  assert.notEqual(db.prepare("SELECT status FROM sources WHERE id='s1'").get().status, "syncing");
});

test("rollback swaps prev batch back", async () => {
  const db = openDb(":memory:");
  mkSource(db);
  await runSync(mkDeps(db, ROWS), "s1", {});
  await runSync(mkDeps(db, [ROWS[0]]), "s1", { force: true });  // second batch (1 row, forced past gate)
  const before = db.prepare("SELECT active_batch_id, prev_batch_id FROM sources WHERE id='s1'").get();
  rollbackSource(db, "s1");
  const after = db.prepare("SELECT active_batch_id, prev_batch_id FROM sources WHERE id='s1'").get();
  assert.equal(after.active_batch_id, before.prev_batch_id);
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/sync/engine.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret } from "../crypto.js";
import { inferColumnMeta, rowToItem } from "../ingest/normalize.js";

const RETRY_MINUTES = [1, 5, 15];

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
    db.prepare("UPDATE sync_runs SET heartbeat_at=? WHERE id=?").run(now(), runId);
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
    const swap = db.transaction(() => {
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
    swap();
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

function backup(db, dataDir, logger) {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `kb-${new Date().toISOString().slice(0, 10)}.db`);
    db.prepare("VACUUM INTO ?").run(file);
    const keep = fs.readdirSync(dir).filter((f) => f.startsWith("kb-")).sort().reverse().slice(7);
    for (const f of keep) fs.unlinkSync(path.join(dir, f));
    logger.info("backup written", { file });
  } catch (err) {
    logger.error("backup failed", { error: String(err) });
  }
}
```

- [ ] **Step 4: Run tests** — PASS. (The "shrink gate" test relies on the CSV connector receiving `{rows: []}` → `rows.length < 1` → gate refuses; both paths covered.)
- [ ] **Step 5: Commit** — `git commit -am "feat: sync engine with atomic swap, retry ladder, crash recovery, backups"`

---

### Task 10: Search engine (structured + text + response shape)

**Files:**
- Create: `src/search/normalize.js`, `src/search/structured.js`, `src/search/text.js`, `src/search/respond.js`
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: `items`/`sources` tables (Task 3), column_meta (Task 9).
- Produces:
  - `normalize.js`: `ALIASES` (seed map: chevy→chevrolet, vw→volkswagen, benz/mercedes benz→mercedes-benz, beemer/bimmer→bmw, subie→subaru, lambo→lamborghini, vette→corvette); `normalizeToken(s)` (lowercase, trim, strip punctuation); `resolveCategorical(value, distincts) -> {value, method: 'exact'|'ci'|'alias'|'fuzzy'|null}` (exact → case-insensitive → alias → Levenshtein ≤ 2); `editDistance(a, b) -> number`.
  - `structured.js`: `searchStructured(db, source, args) -> {items, resultCount, appliedFilters, relaxations, alternatives}`. Filter extraction: merge `args.filters` (object) with recognized top-level keys of `args`; keys `<col>` (categorical equality), `<col>_min`/`<col>_max` (numeric); values `""`/`0`/`null` skipped. Query pipeline: apply filters via `json_extract(structured_json, '$.<col>')`; add FTS rank when `args.query` non-empty; LIMIT 5. Relaxation tiers on 0 results: (1) re-resolve failed categorical values fuzzily; (2) widen numeric bounds ±15%; (3) drop the least-selective filter (the one whose removal yields most results) → results become `alternatives`, not matches; (4) FTS-only on query. Each applied tier appends to `relaxations` (e.g. `"widened price_max to 34500"`).
  - `text.js`: `searchText(db, source, query) -> {items, resultCount}` — FTS5 `MATCH` built as OR of sanitized `"token"*` terms, `bm25(items_fts)` ordering, top 5, snippet from body (first 300 chars around match).
  - `respond.js`: `buildToolResponse({source, structured, textResult, args, tookMs}) -> object` — the wire shape (both channels):

```json
{
  "ok": true,
  "result_count": 2,
  "as_of": "2026-07-13T09:00:00Z",
  "data_freshness": "fresh",
  "applied_filters": { "make": "Toyota", "model": "Tacoma", "price_max": 30000 },
  "relaxations": [],
  "items": [
    { "title": "2022 Toyota Tacoma", "make": "Toyota", "model": "Tacoma", "year": 2022, "price": 28500, "mileage": 31000, "color": "Silver", "vin": "VIN001" }
  ],
  "speech_hint": "Yes - we have 2 Toyota Tacomas under $30,000: a 2022 in silver at $28,500 with 31,000 miles, and a 2021 in red at $26,900.",
  "guidance": "All prices and availability are live as of the last sync. If nothing matched exactly, mention the closest alternatives."
}
```

  - `data_freshness`: `"fresh"` if `last_sync_at` within 2× schedule, else `"stale"` (speech_hint then appends "based on our last update"). `speech_hint` is deterministic template text (≤ 2 sentences); items trimmed to ≤ 8 salient fields; whole JSON target ≤ 1200 chars (drop items from 5 down to fit).

- [ ] **Step 1: Write the failing test**

```js
// test/search.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { resolveCategorical, editDistance } from "../src/search/normalize.js";
import { searchStructured } from "../src/search/structured.js";
import { searchText } from "../src/search/text.js";
import { buildToolResponse } from "../src/search/respond.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import crypto from "node:crypto";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", mileage: "31000", vin: "VIN001", color: "Silver", status: "available" },
  { make: "Toyota", model: "Tacoma", year: "2021", price: "$26,900", mileage: "44000", vin: "VIN002", color: "Red", status: "available" },
  { make: "Toyota", model: "Tundra", year: "2023", price: "$41,000", mileage: "12000", vin: "VIN003", color: "Black", status: "available" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", mileage: "38000", vin: "VIN004", color: "White", status: "available" },
  { make: "Chevrolet", model: "Silverado", year: "2022", price: "$36,750", mileage: "25500", vin: "VIN005", color: "Blue", status: "pending" },
];

let db, source;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inventory','ct','sec','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const item = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", item.title, item.body, JSON.stringify(item.structured));
  }
  source = db.prepare("SELECT * FROM sources WHERE id='s1'").get();
});

test("Tacoma under 30k: exact structured hit", () => {
  const r = searchStructured(db, source, { query: "2022 tacoma", filters: { make: "Toyota", model: "Tacoma", price_max: 30000 } });
  assert.equal(r.resultCount, 2);
  assert.ok(r.items.every((i) => i.structured.price <= 30000 && i.structured.model === "Tacoma"));
  assert.deepEqual(r.relaxations, []);
});

test("alias: chevy resolves to Chevrolet", () => {
  const r = searchStructured(db, source, { query: "", filters: { make: "chevy" } });
  assert.equal(r.resultCount, 1);
  assert.equal(r.items[0].structured.make, "Chevrolet");
});

test("fuzzy: tocoma within edit distance 2", () => {
  assert.equal(editDistance("tocoma", "tacoma"), 1);
  const r = searchStructured(db, source, { query: "", filters: { model: "tocoma" } });
  assert.equal(r.resultCount, 2);
});

test("zero results returns alternatives, never bare empty", () => {
  const r = searchStructured(db, source, { query: "tacoma", filters: { model: "Tacoma", price_max: 20000 } });
  assert.equal(r.resultCount, 0);
  assert.ok(r.alternatives.length >= 1, "must offer closest alternatives");
  assert.ok(r.relaxations.length >= 1);
});

test("ecommerce variant: flat top-level args accepted (no filters object)", () => {
  const r = searchStructured(db, source, { query: "silverado", make: "Chevrolet" });
  assert.equal(r.resultCount, 1);
});

test("text search with bm25 + snippet", () => {
  const r = searchText(db, source, "tundra black");
  assert.ok(r.resultCount >= 1);
  assert.match(r.items[0].snippet, /Tundra/i);
});

test("response shape: compact, speakable, fresh", () => {
  const structured = searchStructured(db, source, { query: "tacoma", filters: { model: "Tacoma", price_max: 30000 } });
  const out = buildToolResponse({ source, structured, args: { query: "tacoma" }, tookMs: 42 });
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 2);
  assert.equal(out.data_freshness, "fresh");
  assert.ok(out.speech_hint.length > 20 && out.speech_hint.length < 400);
  assert.ok(JSON.stringify(out).length <= 1600);
  assert.ok(out.items[0].price);
});

test("stale source is flagged in response", () => {
  const staleSource = { ...source, last_sync_at: "2026-01-01T00:00:00Z" };
  const structured = searchStructured(db, staleSource, { query: "civic", filters: {} });
  const out = buildToolResponse({ source: staleSource, structured, args: {}, tookMs: 5 });
  assert.equal(out.data_freshness, "stale");
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/search/normalize.js
export const ALIASES = new Map(Object.entries({
  chevy: "chevrolet", vw: "volkswagen", benz: "mercedes-benz", "mercedes benz": "mercedes-benz",
  beemer: "bmw", bimmer: "bmw", subie: "subaru", lambo: "lamborghini", vette: "corvette",
}));

export const normalizeToken = (s) => String(s ?? "").toLowerCase().trim().replace(/[^\w\s-]/g, "");

export function editDistance(a, b) {
  a = normalizeToken(a); b = normalizeToken(b);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function resolveCategorical(value, distincts = []) {
  const v = String(value ?? "").trim();
  if (!v) return { value: null, method: null };
  const exact = distincts.find((d) => d === v);
  if (exact) return { value: exact, method: "exact" };
  const ci = distincts.find((d) => d.toLowerCase() === v.toLowerCase());
  if (ci) return { value: ci, method: "ci" };
  const alias = ALIASES.get(normalizeToken(v));
  if (alias) {
    const hit = distincts.find((d) => d.toLowerCase() === alias);
    if (hit) return { value: hit, method: "alias" };
  }
  let best = null, bestDist = 3;
  for (const d of distincts) {
    const dist = editDistance(v, d);
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  if (best && bestDist <= 2) return { value: best, method: "fuzzy" };
  return { value: null, method: null };
}
```

```js
// src/search/structured.js
import { resolveCategorical } from "./normalize.js";

const SENTINEL = (v) => v === "" || v === 0 || v === null || v === undefined;

function extractFilters(args, columns) {
  const byName = Object.fromEntries(columns.map((c) => [c.name.toLowerCase(), c]));
  const raw = { ...(typeof args.filters === "object" && args.filters ? args.filters : {}) };
  for (const [k, v] of Object.entries(args)) {
    if (["query", "filters"].includes(k)) continue;
    raw[k] = raw[k] ?? v;
  }
  const filters = [];
  for (const [key, value] of Object.entries(raw)) {
    if (SENTINEL(value)) continue;
    const m = key.toLowerCase().match(/^(.*)_(min|max)$/);
    if (m && byName[m[1]]?.kind === "numeric") {
      filters.push({ col: byName[m[1]].name, op: m[2], value: Number(value) });
    } else if (byName[key.toLowerCase()]) {
      const col = byName[key.toLowerCase()];
      if (col.kind === "numeric") filters.push({ col: col.name, op: "eq", value: Number(value) });
      else filters.push({ col: col.name, op: "cat", value: String(value), distincts: col.distincts || [] });
    }
  }
  return filters;
}

function runQuery(db, source, filters, query) {
  const where = ["i.source_id = ?", "i.batch_id = ?"];
  const params = [source.id, source.active_batch_id];
  for (const f of filters) {
    // JSON path is BOUND, never interpolated — column names come from tenant
    // data (CSV headers, feed keys) and must not reach SQL as literals.
    const path = "json_extract(i.structured_json, ?)";
    const pathArg = `$.${f.col}`;
    if (f.op === "min") { where.push(`CAST(${path} AS REAL) >= ?`); params.push(pathArg, f.value); }
    else if (f.op === "max") { where.push(`CAST(${path} AS REAL) <= ?`); params.push(pathArg, f.value); }
    else if (f.op === "eq") { where.push(`CAST(${path} AS REAL) = ?`); params.push(pathArg, f.value); }
    else { where.push(`${path} = ?`); params.push(pathArg, f.resolved ?? f.value); }
  }
  const tokens = String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  if (tokens.length) {
    const match = tokens.map((t) => `"${t}"*`).join(" OR ");
    const sql = `SELECT i.*, bm25(items_fts) AS rank FROM items i JOIN items_fts ON items_fts.rowid = i.rowid
                 WHERE ${where.join(" AND ")} AND items_fts MATCH ? ORDER BY rank LIMIT 5`;
    const withFts = db.prepare(sql).all(...params, match);
    if (withFts.length) return withFts;
  }
  return db.prepare(`SELECT i.* FROM items i WHERE ${where.join(" AND ")} LIMIT 5`).all(...params);
}

export function searchStructured(db, source, args = {}) {
  const columns = JSON.parse(source.column_meta_json || "[]");
  const filters = extractFilters(args, columns);
  const relaxations = [];
  const appliedFilters = {};

  for (const f of filters.filter((f) => f.op === "cat")) {
    const res = resolveCategorical(f.value, f.distincts);
    if (res.value) {
      f.resolved = res.value;
      if (res.method === "alias" || res.method === "fuzzy") relaxations.push(`interpreted ${f.col} "${f.value}" as "${res.value}"`);
    } else {
      relaxations.push(`ignored unrecognized ${f.col} "${f.value}"`);
      f.skip = true;
    }
  }
  let active = filters.filter((f) => !f.skip);
  for (const f of active) appliedFilters[f.op === "cat" ? f.col : `${f.col}_${f.op}`] = f.resolved ?? f.value;

  const wrap = (rows) => rows.map((r) => ({ ...r, structured: JSON.parse(r.structured_json) }));
  let rows = runQuery(db, source, active, args.query);
  if (rows.length) return { items: wrap(rows), resultCount: rows.length, appliedFilters, relaxations, alternatives: [] };

  // Tier 2: widen numeric bounds ±15%
  const widened = active.map((f) =>
    f.op === "max" ? { ...f, value: Math.round(f.value * 1.15) } :
    f.op === "min" ? { ...f, value: Math.round(f.value * 0.85) } : f
  );
  rows = runQuery(db, source, widened, args.query);
  if (rows.length) {
    for (const f of widened) if (["min", "max"].includes(f.op)) relaxations.push(`widened ${f.col}_${f.op} to ${f.value}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(rows) };
  }

  // Tier 3: drop the filter whose removal yields the most results
  let best = { rows: [], dropped: null };
  for (let i = 0; i < active.length; i++) {
    const subset = active.filter((_, j) => j !== i);
    const r = runQuery(db, source, subset, args.query);
    if (r.length > best.rows.length) best = { rows: r, dropped: active[i] };
  }
  if (best.rows.length) {
    relaxations.push(`no exact match; closest ignoring ${best.dropped.col}`);
    return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(best.rows.slice(0, 3)) };
  }

  // Tier 4: query-only FTS
  rows = runQuery(db, source, [], args.query);
  if (rows.length) relaxations.push("no filter match; keyword-only results");
  return { items: [], resultCount: 0, appliedFilters, relaxations, alternatives: wrap(rows.slice(0, 3)) };
}
```

```js
// src/search/text.js
export function searchText(db, source, query) {
  const tokens = String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  if (!tokens.length) return { items: [], resultCount: 0 };
  const match = tokens.map((t) => `"${t}"*`).join(" OR ");
  const rows = db.prepare(
    `SELECT i.title, i.body, bm25(items_fts) AS rank FROM items i
     JOIN items_fts ON items_fts.rowid = i.rowid
     WHERE i.source_id = ? AND i.batch_id = ? AND items_fts MATCH ?
     ORDER BY rank LIMIT 5`
  ).all(source.id, source.active_batch_id, match);
  return {
    items: rows.map((r) => ({ title: r.title, snippet: r.body.slice(0, 300) })),
    resultCount: rows.length,
  };
}
```

```js
// src/search/respond.js
const SALIENT_MAX = 8;

function trimItem(structured) {
  const entries = Object.entries(structured).filter(([, v]) => v !== null && v !== "").slice(0, SALIENT_MAX);
  return Object.fromEntries(entries);
}

function money(n) { return typeof n === "number" && n >= 1000 ? `$${n.toLocaleString("en-US")}` : String(n); }

function speechHint({ resultCount, items, alternatives, relaxations }) {
  if (resultCount > 0) {
    const first = items[0];
    const desc = [first.year, first.make, first.model].filter(Boolean).join(" ") || first.title || "match";
    const price = first.price ? ` at ${money(first.price)}` : "";
    return resultCount === 1
      ? `Yes - we have one match: a ${desc}${price}.`
      : `Yes - ${resultCount} matches. Best fit: a ${desc}${price}.`;
  }
  if (alternatives.length) {
    const a = alternatives[0];
    const desc = [a.year, a.make, a.model].filter(Boolean).join(" ") || a.title || "option";
    return `No exact match, but the closest we have is a ${desc}${a.price ? ` at ${money(a.price)}` : ""}. ${relaxations[0] || ""}`.trim();
  }
  return "Nothing in our current live data matches that. Offer to check related options or take a message.";
}

export function buildToolResponse({ source, structured, textResult, args, tookMs }) {
  const base = {
    ok: true,
    as_of: source.last_sync_at,
    data_freshness: source.last_sync_at && Date.now() - Date.parse(source.last_sync_at) < 2 * source.schedule_minutes * 60_000 ? "fresh" : "stale",
  };
  if (textResult) {
    return {
      ...base,
      result_count: textResult.resultCount,
      items: textResult.items,
      speech_hint: textResult.resultCount
        ? `Found it: ${textResult.items[0].snippet.slice(0, 140)}`
        : "I couldn't find that on the live site data. Offer to take a message.",
      took_ms: tookMs,
    };
  }
  const items = structured.resultCount ? structured.items.map((i) => ({ title: i.title, ...trimItem(i.structured) })) : [];
  const alternatives = structured.alternatives.map((i) => ({ title: i.title, ...trimItem(i.structured) }));
  const out = {
    ...base,
    result_count: structured.resultCount,
    applied_filters: structured.appliedFilters,
    relaxations: structured.relaxations,
    items,
    ...(alternatives.length ? { close_alternatives: alternatives } : {}),
    speech_hint: speechHint({ resultCount: structured.resultCount, items: structured.items.map((i) => i.structured), alternatives: structured.alternatives.map((i) => i.structured), relaxations: structured.relaxations }),
    guidance: "Data is live from the business's own system. If data_freshness is 'stale', say the info is from the last update. Never invent items not listed.",
    took_ms: tookMs,
  };
  while (JSON.stringify(out).length > 1600 && out.items.length > 1) out.items.pop();
  return out;
}
```

- [ ] **Step 4: Run tests** — PASS (9/9).
- [ ] **Step 5: Commit** — `git commit -am "feat: structured search with alias/fuzzy resolution, tiered relaxation, speakable responses"`

---

### Task 11: Assistable client + tool definition builder

**Files:**
- Create: `src/assistable/client.js`, `src/assistable/tool-def.js`
- Test: `test/assistable.test.js`

**Interfaces:**
- Consumes: Platform Contract section facts (esp. #5).
- Produces:
  - `AssistableClient({apiKey, base, mock, logger, fetchImpl}) ` with methods `listAssistants() -> [{id,name,...}]`, `createTool(def) -> {id}`, `getTool(id)`, `updateTool(id, def)`, `deleteTool(id)`, `assignTool(toolId, assistantId)`, `removeTool(toolId, assistantId)`, `verifyKey() -> boolean` (GET /v3/assistants, 200 = valid). All requests: `Authorization: Bearer <key>` **and** `x-api-key: <key>` (send both — header name not verifiable in source; integration Task 15 confirms which is honored and drops the other). Unwraps `{data,error,request_id}`; on 429 waits `Retry-After` (cap 15s) and retries once; on 409 from createTool retries once with `-2` suffix on name. In mock mode: logs the payload, returns `{id: "mock-tool-<n>"}`, records calls on `client.mockCalls` for tests.
  - `buildToolDefinition(source, columnMeta, {baseUrl, secret}) -> v3 create-tool body`:
    - `name`: `live_data_` + source name slugified `[a-zA-Z0-9_-]`, ≤ 64 chars.
    - `tool_type: "FUNCTION"`, `http_method: "POST"`, `url: ${baseUrl}/api/tools/${source.id}/search`, `headers: {"x-bridge-secret": secret}`, `required_params: []`.
    - `parameters`: flat JSON-Schema. Always `query` (string). Plus up to 6 generated filter params: numeric col → `<col>_min`/`<col>_max` (number, description includes observed range, "use 0 if not mentioned"); categorical col → `<col>` (string, description lists up to 25 allowed values, "use \"\" if not mentioned"). Column priority: categorical with 2-25 distincts first (most selective), then numerics; skip text cols. Website sources: `query` only.
    - `description`: template — `Live ${source.name} lookup. ALWAYS call this before answering any question about ${source.name}. Returns current data with a speech_hint you can read aloud. Never invent items; only state what this tool returns. Filterable: ${filter summary}.`

- [ ] **Step 1: Write the failing test**

```js
// test/assistable.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistableClient } from "../src/assistable/client.js";
import { buildToolDefinition } from "../src/assistable/tool-def.js";

const noopLog = { info() {}, warn() {}, error() {} };

test("mock client records calls and returns ids", async () => {
  const c = new AssistableClient({ apiKey: "k", mock: true, logger: noopLog });
  const created = await c.createTool({ name: "live_data_inventory" });
  assert.match(created.id, /^mock-tool-/);
  assert.equal(c.mockCalls[0].method, "POST");
  assert.equal(c.mockCalls[0].path, "/v3/tools");
});

test("real client unwraps envelope and sends auth headers", async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { status: 200, json: async () => ({ data: [{ id: "a1", name: "Riva" }], error: null, request_id: "r" }) };
  };
  const c = new AssistableClient({ apiKey: "sek", base: "https://api.test", mock: false, logger: noopLog, fetchImpl });
  const assistants = await c.listAssistants();
  assert.equal(assistants[0].id, "a1");
  assert.equal(captured.opts.headers["authorization"], "Bearer sek");
  assert.equal(captured.opts.headers["x-api-key"], "sek");
  assert.ok(!captured.url.includes("include_archived"), "must omit include_archived (coercion footgun)");
});

test("409 on createTool retries with suffixed name", async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? { status: 409, json: async () => ({ data: null, error: { code: "conflict" } }) }
      : { status: 201, json: async () => ({ data: { id: "t2" }, error: null }) };
  };
  const c = new AssistableClient({ apiKey: "k", base: "https://api.test", mock: false, logger: noopLog, fetchImpl });
  const r = await c.createTool({ name: "live_data_inv" });
  assert.equal(r.id, "t2");
  assert.equal(bodies[1].name, "live_data_inv-2");
});

test("buildToolDefinition: flat stable schema with sentinels", () => {
  const source = { id: "s1", name: "Riverside Inventory" };
  const meta = [
    { name: "make", kind: "categorical", distincts: ["Toyota", "Honda", "Chevrolet"] },
    { name: "model", kind: "categorical", distincts: ["Tacoma", "Civic", "Silverado"] },
    { name: "year", kind: "numeric", min: 2021, max: 2023 },
    { name: "price", kind: "numeric", min: 19900, max: 41000 },
    { name: "vin", kind: "text" },
  ];
  const def = buildToolDefinition(source, meta, { baseUrl: "https://kb.example.com", secret: "shh" });
  assert.match(def.name, /^live_data_[a-zA-Z0-9_-]+$/);
  assert.ok(def.name.length <= 64);
  assert.equal(def.tool_type, "FUNCTION");
  assert.equal(def.url, "https://kb.example.com/api/tools/s1/search");
  assert.equal(def.headers["x-bridge-secret"], "shh");
  const props = def.parameters.properties;
  assert.ok(props.query);
  assert.ok(props.make.description.includes("Toyota"));
  assert.ok(props.price_min && props.price_max);
  assert.ok(!props.vin, "text cols excluded");
  assert.match(props.make.description, /""/);
  assert.match(def.description, /ALWAYS call/);
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/assistable/client.js
export class AssistableClient {
  constructor({ apiKey, base = "https://apiv3.createassistants.com", mock = false, logger, fetchImpl = fetch }) {
    this.apiKey = apiKey; this.base = base; this.mock = mock; this.logger = logger;
    this.fetchImpl = fetchImpl; this.mockCalls = []; this._mockN = 0;
  }

  async _req(method, path, body) {
    if (this.mock) {
      this.mockCalls.push({ method, path, body });
      this.logger.info("MOCK assistable call", { method, path });
      if (method === "POST" && path === "/v3/tools") return { id: `mock-tool-${++this._mockN}` };
      if (path === "/v3/assistants") return [{ id: "mock-assistant-1", name: "Mock Assistant" }];
      return { ok: true };
    }
    const doFetch = () => this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let res = await doFetch();
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers?.get?.("retry-after") || 2), 15);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await doFetch();
    }
    const payload = await res.json().catch(() => ({}));
    if (res.status === 409) { const e = new Error("conflict"); e.status = 409; throw e; }
    if (res.status >= 400) {
      const e = new Error(payload?.error?.message || `assistable API ${res.status}`);
      e.status = res.status; throw e;
    }
    return payload.data ?? payload;
  }

  listAssistants() { return this._req("GET", "/v3/assistants?limit=100"); }
  async verifyKey() { try { await this.listAssistants(); return true; } catch { return false; } }
  async createTool(def) {
    try { return await this._req("POST", "/v3/tools", def); }
    catch (e) {
      if (e.status !== 409) throw e;
      return this._req("POST", "/v3/tools", { ...def, name: `${def.name}-2`.slice(0, 64) });
    }
  }
  getTool(id) { return this._req("GET", `/v3/tools/${id}`); }
  updateTool(id, def) { return this._req("PATCH", `/v3/tools/${id}`, def); }
  deleteTool(id) { return this._req("DELETE", `/v3/tools/${id}`); }
  assignTool(toolId, assistantId) { return this._req("POST", `/v3/tools/${toolId}/assign`, { assistant_id: assistantId }); }
  removeTool(toolId, assistantId) { return this._req("POST", `/v3/tools/${toolId}/remove`, { assistant_id: assistantId }); }
}
```

```js
// src/assistable/tool-def.js
const MAX_FILTER_PARAMS = 6;

const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "source";

export function buildToolDefinition(source, columnMeta, { baseUrl, secret }) {
  const properties = {
    query: { type: "string", description: "What the customer is asking for, in plain words. Always provide it." },
  };
  const filterSummaries = [];
  const categoricals = columnMeta.filter((c) => c.kind === "categorical" && (c.distincts?.length ?? 0) >= 2);
  const numerics = columnMeta.filter((c) => c.kind === "numeric");
  let slots = MAX_FILTER_PARAMS;
  for (const c of categoricals) {
    if (slots <= 0) break;
    properties[c.name] = {
      type: "string",
      description: `Filter by ${c.name}. Allowed values: ${c.distincts.slice(0, 25).join(", ")}. Use "" if the customer did not mention it.`,
    };
    filterSummaries.push(c.name);
    slots--;
  }
  for (const c of numerics) {
    if (slots < 2) break;
    properties[`${c.name}_min`] = { type: "number", description: `Minimum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
    properties[`${c.name}_max`] = { type: "number", description: `Maximum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
    filterSummaries.push(`${c.name} range`);
    slots -= 2;
  }
  return {
    name: `live_data_${slug(source.name)}`.slice(0, 64),
    description: `Live ${source.name} lookup. ALWAYS call this before answering any question about ${source.name}. Returns current data plus a speech_hint you can read aloud. Never invent items; only state what this tool returns.${filterSummaries.length ? ` Filterable by: ${filterSummaries.join(", ")}.` : ""}`,
    tool_type: "FUNCTION",
    http_method: "POST",
    url: `${baseUrl}/api/tools/${source.id}/search`,
    headers: { "x-bridge-secret": secret },
    parameters: { type: "object", properties },
    required_params: [],
  };
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: assistable v3 client (mockable) + stable flat tool schema builder"`

---### Task 12: Tool search endpoint (the webhook Assistable calls)

**Files:**
- Create: `src/routes/tool-api.js`
- Test: `test/tool-api.test.js`

**Interfaces:**
- Consumes: `constantTimeEqual` (Task 2), search modules (Task 10), tables (Task 3).
- Produces: `createToolApiRouter({db, logger}) -> express.Router` mounting `POST /api/tools/:sourceId/search`. Behavior (per Platform Contract): unknown source or bad/missing `x-bridge-secret` → **404 empty** (not retried by proxy). All other outcomes → **HTTP 200**. Envelope parsing: `body.args` used when `body.meta_data || body.metadata || body.call` present, else body itself. Internal deadline 2500ms → on breach or exception: `{ok:false, error:"temporarily_unavailable", speech_hint:"I couldn't check the live data just now - offer to try again in a moment."}`. Sources with `active_batch_id IS NULL` → 200 `{ok:false, error:"not_synced", speech_hint:"The live data hasn't finished its first sync yet."}`. Every call logged to `tool_calls`. Per-source rate limit 60/min → 200 `{ok:false, error:"rate_limited", speech_hint:"..."}` (never HTTP 429 — the proxy would retry and stall the call).

- [ ] **Step 1: Write the failing test**

```js
// test/tool-api.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import crypto from "node:crypto";

const CARS = [
  { make: "Toyota", model: "Tacoma", year: "2022", price: "$28,500", vin: "VIN001" },
  { make: "Honda", model: "Civic", year: "2021", price: "$19,900", vin: "VIN004" },
];
let base, db;

before(async () => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  const meta = inferColumnMeta(CARS);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('s1','u1','csv','inv','ct','topsecret','active','b1',?,?,1440,'2026-01-01')`)
    .run(JSON.stringify(meta), new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of CARS) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "s1", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(createToolApiRouter({ db, logger: { info() {}, warn() {}, error() {} } }));
  const srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("valid envelope call returns results", async () => {
  const res = await call("/api/tools/s1/search",
    { args: { query: "tacoma", make: "Toyota", price_max: 30000 }, meta_data: { tool_id: "t" }, metadata: {}, call: { call_id: "c1" } },
    { "x-bridge-secret": "topsecret" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
  assert.ok(out.speech_hint);
  const logged = db.prepare("SELECT * FROM tool_calls WHERE source_id='s1'").all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].ok, 1);
});

test("raw args body (direct mode) also works", async () => {
  const res = await call("/api/tools/s1/search", { query: "civic" }, { "x-bridge-secret": "topsecret" });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
});

test("bad secret -> 404 empty", async () => {
  const res = await call("/api/tools/s1/search", { query: "x" }, { "x-bridge-secret": "wrong" });
  assert.equal(res.status, 404);
  assert.equal((await res.text()).length, 0);
});

test("missing secret -> 404; unknown source -> 404", async () => {
  assert.equal((await call("/api/tools/s1/search", {})).status, 404);
  assert.equal((await call("/api/tools/nope/search", {}, { "x-bridge-secret": "topsecret" })).status, 404);
});

test("never-synced source -> 200 with speakable error", async () => {
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,column_meta_json,schedule_minutes,created_at)
              VALUES ('s2','u1','csv','new','ct','sec2','never_synced','[]',1440,'2026-01-01')`).run();
  const res = await call("/api/tools/s2/search", { query: "x" }, { "x-bridge-secret": "sec2" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.equal(out.error, "not_synced");
  assert.ok(out.speech_hint);
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/routes/tool-api.js
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
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: tool search webhook - envelope parsing, 200-always contract, call logging"`

---

### Task 13: Dashboard routes + views

**Files:**
- Create: `src/routes/dashboard.js`, `src/views/pages.js`
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: auth (Task 5), tenant DAL (Task 5), sync engine (Task 9), Assistable client + tool-def (Task 11), crypto (Task 2).
- Produces: `createDashboardRouter(deps) -> Router` where deps = `{db, config, logger, connectors, makeClient(userApiKey) -> AssistableClient}`. Routes:
  - `GET /` → redirect `/sources` (or `/login`).
  - `GET/POST /signup`, `GET/POST /login`, `POST /logout`. POST bodies are JSON via fetch (header `x-requested-with: kb-bridge`).
  - `GET/POST /connect` — paste Assistable API key; POST verifies via `client.verifyKey()`, stores `encryptSecret(key)`, never echoes it back (page shows `Connected ✓ (key ending …last4)` only).
  - `GET /sources` — list with status chips; `GET/POST /sources/new` — type + name + config (feed URL / CSV upload via multer memory 5MB / website URL / pg conn string + table) + schedule; creates source (`secret = newSecret()`, config encrypted), kicks first `runSync` in background, then creates + assigns tool: `buildToolDefinition` → `client.createTool` → `client.assignTool` per selected assistant (assistant picker fetched live from `client.listAssistants()`); persists to `tools` table; failures land in `tools.last_error` and render in UI.
  - `POST /sources/:id/sync` (Sync now, `force` checkbox), `POST /sources/:id/rollback`, `POST /sources/:id/delete` (removes tool assignments + deletes tool via API best-effort, then cascades DB delete).
  - `GET /sources/:id` — detail: sync history (last 10 runs), tool status, column meta, test-search box (calls searchStructured directly), recent `tool_calls` with zero-result queries highlighted ("unanswered queries" — the accuracy flywheel), voice re-save notice when tool description changed since creation.
  - `GET /healthz` → `{ok:true}` public.
  - All `/sources*` and `/connect` behind `requireUser`; **every** source access via `ownedSource` (404 on other tenants' ids).
- Views (`pages.js`): `layoutPage(title, bodyHtml)`, `esc(s)` HTML-escaper applied to ALL interpolations; forms posted by a 10-line inline `fetch` helper (CSP allows `'unsafe-inline'` for the single small script block — documented tradeoff, no external scripts) with `x-requested-with: kb-bridge` header.

- [ ] **Step 1: Write the failing test** (routes only — views asserted by content sniff)

```js
// test/dashboard.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { startTestApp } from "./helpers.js";

let t; // {base, db, cookies}
before(async () => { t = await startTestApp(); });

async function post(path, body, cookie) {
  return fetch(`${t.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-requested-with": "kb-bridge", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("signup -> login -> connect (mock) -> create csv source -> tool provisioned", async () => {
  let res = await post("/signup", { email: "o@d.co", password: "longenough1" });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  res = await post("/connect", { api_key: "ak-test-123" }, cookie);
  assert.equal((await res.json()).ok, true);

  res = await post("/sources/new", {
    type: "csv", name: "Inventory", schedule_minutes: 1440,
    csv_text: "make,model,year,price\nToyota,Tacoma,2022,\"$28,500\"\nHonda,Civic,2021,\"$19,900\"",
    assistant_ids: ["mock-assistant-1"],
  }, cookie);
  const created = await res.json();
  assert.equal(created.ok, true);

  // first sync ran; tool row exists with mock id
  const src = t.db.prepare("SELECT * FROM sources WHERE name='Inventory'").get();
  assert.equal(src.status, "active");
  const tool = t.db.prepare("SELECT * FROM tools WHERE source_id=?").get(src.id);
  assert.match(tool.tool_id, /^mock-tool-/);
});

test("CSRF: mutation without header is rejected", async () => {
  const res = await fetch(`${t.base}/sources/new`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.ok([302, 403].includes(res.status)); // no session -> redirect; with session -> 403
});

test("IDOR: second user cannot see or sync first user's source", async () => {
  let res = await post("/signup", { email: "evil@d.co", password: "longenough1" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const src = t.db.prepare("SELECT id FROM sources WHERE name='Inventory'").get();
  res = await fetch(`${t.base}/sources/${src.id}`, { headers: { cookie } });
  assert.equal(res.status, 404);
  res = await post(`/sources/${src.id}/sync`, {}, cookie);
  assert.equal(res.status, 404);
});

test("api key never echoed back", async () => {
  const res = await fetch(`${t.base}/connect`, { headers: { cookie: t.ownerCookie } });
  const html = await res.text();
  assert.ok(!html.includes("ak-test-123"));
});
```

- [ ] **Step 2: Create `test/helpers.js`**

```js
// test/helpers.js
import express from "express";
import { openDb } from "../src/db.js";
import { createDashboardRouter } from "../src/routes/dashboard.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { AssistableClient } from "../src/assistable/client.js";
import { cookieParser } from "../src/auth.js";

const noopLog = { info() {}, warn() {}, error() {} };
const KEY = Buffer.alloc(32, 5).toString("base64");

export async function startTestApp() {
  const db = openDb(":memory:");
  const config = { encryptionKey: KEY, baseUrl: "http://test", dataDir: "./data", nodeEnv: "test", mockAssistable: true };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser);
  app.use(createToolApiRouter({ db, logger: noopLog }));
  app.use(createDashboardRouter({
    db, config, logger: noopLog,
    connectors: {
      csv: async (cfg) => (await import("../src/connectors/csv.js")).parseCsvItems(cfg.csv_text),
      feed: async () => ({ rows: [] }), website: async () => ({ rows: [] }), database: async () => ({ rows: [] }),
    },
    makeClient: () => new AssistableClient({ apiKey: "x", mock: true, logger: noopLog }),
  }));
  const srv = app.listen(0);
  const t = { base: `http://127.0.0.1:${srv.address().port}`, db, srv };
  // convenience: owner cookie for later tests
  const res = await fetch(`${t.base}/signup`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge" }, body: JSON.stringify({ email: "owner@x.co", password: "longenough1" }) });
  t.ownerCookie = res.headers.get("set-cookie")?.split(";")[0];
  return t;
}
```

(Add `cookieParser` export to `src/auth.js`: 12 lines parsing the `cookie` header into `req.cookies` — shown below.)

```js
// append to src/auth.js
export function cookieParser(req, _res, next) {
  req.cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
}
```

- [ ] **Step 3: Run to fail.**

- [ ] **Step 4: Implement `src/views/pages.js`** (representative; keep spartan)

```js
// src/views/pages.js
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function layoutPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - KB Bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui;margin:2rem auto;max-width:860px;padding:0 1rem;color:#111}
nav a{margin-right:1rem}.chip{padding:2px 8px;border-radius:10px;font-size:12px}
.chip.active{background:#d4f7dc}.chip.stale{background:#fff3cd}.chip.error{background:#f8d7da}
.chip.syncing,.chip.never_synced{background:#e2e3e5}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}input,select,textarea{width:100%;padding:6px;margin:4px 0}
button{padding:8px 14px;cursor:pointer}.err{color:#b00}.warn{background:#fff3cd;padding:8px;border-radius:6px}</style></head>
<body><nav><a href="/sources">Sources</a><a href="/connect">Connection</a>
<a href="#" onclick="api('/logout',{}).then(()=>location='/login');return false">Log out</a></nav>
${body}
<script>
async function api(path, body){
  const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-requested-with':'kb-bridge'},body:JSON.stringify(body)});
  const out = await r.json().catch(()=>({ok:false,error:'HTTP '+r.status}));
  if(!out.ok && out.error) alert(out.error);
  return out;
}
function formJson(f){const o={};new FormData(f).forEach((v,k)=>{o[k]=v});return o}
</script></body></html>`;
}
```

Pages (same file, appended to `src/views/pages.js`) — all dynamic values wrapped in `esc()`:

```js
const authForm = (action, label) => `
<h1>${label}</h1><form onsubmit="api('${action}',formJson(this)).then(o=>o.ok&&(location='/sources'));return false">
<input name="email" type="email" placeholder="email" required>
<input name="password" type="password" placeholder="password (min 10 chars)" minlength="10" required>
<button>${label}</button></form>
<p><a href="${action === "/login" ? "/signup" : "/login"}">${action === "/login" ? "Create an account" : "Have an account? Log in"}</a></p>`;

export const loginPage = () => layoutPage("Log in", authForm("/login", "Log in"));
export const signupPage = () => layoutPage("Sign up", authForm("/signup", "Sign up"));

export const connectPage = (conn) => layoutPage("Connection", `
<h1>Assistable connection</h1>
${conn ? `<p>Status: <span class="chip active">connected</span></p>` : `<p>Not connected yet.</p>`}
<form onsubmit="api('/connect',formJson(this)).then(o=>o.ok&&location.reload());return false">
<input name="api_key" type="password" placeholder="Paste your Assistable v3 API key" autocomplete="off" required>
<button>${conn ? "Replace key" : "Connect"}</button></form>
<p>The key is verified against the Assistable API, encrypted at rest, and never shown again.</p>`);

export const sourcesPage = (sources) => layoutPage("Sources", `
<h1>Dynamic sources</h1><p><a href="/sources/new">+ Add source</a></p>
<table><tr><th>Name</th><th>Type</th><th>Status</th><th>Last sync</th></tr>
${sources.map((s) => `<tr><td><a href="/sources/${esc(s.id)}">${esc(s.name)}</a></td><td>${esc(s.type)}</td>
<td><span class="chip ${esc(s.status)}">${esc(s.status)}</span></td><td>${esc(s.last_sync_at ?? "never")}</td></tr>`).join("")}
</table>`);

export const newSourcePage = (assistants, notConnected) => layoutPage("New source", `
<h1>New dynamic source</h1>
${notConnected ? `<p class="warn">Connect your Assistable account first - the tool can't be created without it.</p>` : ""}
<form onsubmit="submitSource(this);return false">
<label>Name <input name="name" required maxlength="60"></label>
<label>Type <select name="type" onchange="document.querySelectorAll('[data-cfg]').forEach(d=>d.style.display=d.dataset.cfg===this.value?'':'none')">
<option value="csv">CSV upload</option><option value="feed">Feed URL</option>
<option value="website">Website</option><option value="database">Postgres / Supabase</option></select></label>
<div data-cfg="csv"><label>CSV file <input type="file" id="csvfile" accept=".csv"></label></div>
<div data-cfg="feed" style="display:none"><label>Feed URL <input name="url" type="url"></label></div>
<div data-cfg="website" style="display:none"><label>Site URL <input name="url" type="url"></label></div>
<div data-cfg="database" style="display:none"><label>Connection string <input name="connection_string"></label>
<label>Table or view <input name="table"></label></div>
<label>Re-sync every <select name="schedule_minutes"><option value="1440">day</option>
<option value="360">6 hours</option><option value="60">hour</option></select></label>
<fieldset><legend>Attach to assistants</legend>
${assistants.map((a) => `<label><input type="checkbox" name="assistant" value="${esc(a.id)}"> ${esc(a.name)}</label>`).join("")}
</fieldset><button>Create + provision tool</button></form>
<script>
async function submitSource(f){
  const body = formJson(f);
  body.assistant_ids = [...f.querySelectorAll('input[name=assistant]:checked')].map(c=>c.value);
  delete body.assistant;
  const file = document.getElementById('csvfile')?.files[0];
  if (body.type === 'csv' && file) body.csv_text = await file.text();
  const o = await api('/sources/new', body);
  if (o.ok) location = '/sources/' + o.source_id;
}
</script>`);

export const sourceDetailPage = (source, runs, tool, calls, unanswered) => layoutPage(source.name, `
<h1>${esc(source.name)} <span class="chip ${esc(source.status)}">${esc(source.status)}</span></h1>
<p>Type: ${esc(source.type)} - last sync ${esc(source.last_sync_at ?? "never")} - next ${esc(source.next_run_at ?? "-")}</p>
${tool?.tool_id ? `<p>Tool: <code>${esc(tool.tool_id)}</code> on ${esc(JSON.parse(tool.assistant_ids_json).length)} assistant(s)</p>` : ""}
${tool?.last_error ? `<p class="err">Tool provisioning error: ${esc(tool.last_error)}</p>` : ""}
${tool && tool.updated_at > tool.created_at ? `<p class="warn">Voice agents cache the tool schema - re-save the assistant in Assistable to refresh voice.</p>` : ""}
<p>
<button onclick="api('/sources/${esc(source.id)}/sync',{}).then(()=>location.reload())">Sync now</button>
<button onclick="api('/sources/${esc(source.id)}/sync',{force:true}).then(()=>location.reload())">Force sync</button>
<button onclick="api('/sources/${esc(source.id)}/rollback',{}).then(()=>location.reload())">Roll back</button>
<button onclick="confirm('Delete source and its Assistable tool?')&&api('/sources/${esc(source.id)}/delete',{}).then(()=>location='/sources')">Delete</button>
</p>
<h2>Sync history</h2>
<table><tr><th>Started</th><th>Status</th><th>Items</th><th>Error</th></tr>
${runs.map((r) => `<tr><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td><td>${esc(r.items_count ?? "-")}</td><td>${esc(r.error ?? "")}</td></tr>`).join("")}</table>
<h2>Recent agent queries</h2>
<table><tr><th>When</th><th>Args</th><th>Results</th><th>ms</th></tr>
${calls.map((c) => `<tr><td>${esc(c.ts)}</td><td><code>${esc(c.args_json.slice(0, 120))}</code></td><td>${esc(c.result_count ?? "-")}</td><td>${esc(c.took_ms)}</td></tr>`).join("")}</table>
${unanswered.length ? `<h2>Unanswered queries (0 results)</h2><ul>
${unanswered.map((u) => `<li><code>${esc(u.args_json.slice(0, 140))}</code> - asked ${esc(u.n)}x</li>`).join("")}</ul>
<p>Fix these by adding the missing items to your data, or extending aliases.</p>` : ""}`);
```

- [ ] **Step 5: Implement `src/routes/dashboard.js`**

```js
// src/routes/dashboard.js
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

  router.post("/signup", loginLimiter, async (req, res) => {
    try {
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
    res.send(pages.connectPage(conn && { status: conn.status, last4: "****" }));
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
```

- [ ] **Step 6: Run tests** — `node --test test/dashboard.test.js` → PASS.
- [ ] **Step 7: Commit** — `git commit -am "feat: dashboard - signup/login/connect/sources with tool auto-provisioning"`

---

### Task 14: Server wiring + hardening middleware

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildApp(deps) -> express app` (exported for tests) and a main block that: loads config, opens `${dataDir}/kb-bridge.db`, wires middleware **in this order**: 1) helmet (CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`), 2) global rate limit 300/min/IP, 3) `express.json({limit:'256kb'})` + urlencoded off, 4) cookieParser, 5) tool-api router (before auth — webhook has its own auth), 6) dashboard router, 7) 404 + error handler (logs, generic 500, never leaks stack). Starts `startScheduler`, listens on config.port, graceful shutdown on SIGINT/SIGTERM (stop scheduler, close server, `db.close()`).

- [ ] **Step 1: Write the failing test**

```js
// test/server.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import { openDb } from "../src/db.js";

test("app boots, healthz ok, security headers set, 404 handled", async () => {
  const app = buildApp({
    db: openDb(":memory:"),
    config: { encryptionKey: Buffer.alloc(32, 1).toString("base64"), baseUrl: "http://t", dataDir: "./data", nodeEnv: "test", mockAssistable: true, port: 0 },
    logger: { info() {}, warn() {}, error() {} },
  });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'self'"));
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
  srv.close();
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```js
// src/server.js
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { openDb } from "./db.js";
import { cookieParser } from "./auth.js";
import { createToolApiRouter } from "./routes/tool-api.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { startScheduler } from "./sync/engine.js";
import { AssistableClient } from "./assistable/client.js";
import { fetchFeedItems } from "./connectors/feed.js";
import { parseCsvItems } from "./connectors/csv.js";
import { crawlSiteItems } from "./connectors/website.js";
import { fetchDbItems } from "./connectors/database.js";
import * as pages from "./views/pages.js";

export function buildApp(deps) {
  const { db, config, logger } = deps;
  const connectors = deps.connectors ?? {
    feed: (cfg) => fetchFeedItems(cfg),
    csv: async (cfg) => parseCsvItems(cfg.csv_text),
    website: (cfg) => crawlSiteItems(cfg, { delayMs: 300 }),
    database: (cfg) => fetchDbItems(cfg),
  };
  const makeClient = deps.makeClient ?? ((apiKey) =>
    new AssistableClient({ apiKey, base: config.assistableApiBase, mock: config.mockAssistable, logger }));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
      frameAncestors: ["'none'"],
    }},
  }));
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser);
  app.use(createToolApiRouter({ db, logger }));
  app.use(createDashboardRouter({ db, config, logger, connectors, makeClient }));
  app.use((_req, res) => res.status(404).send(pages.layoutPage("Not found", "<p>Page not found.</p>")));
  app.use((err, _req, res, _next) => {
    logger.error("unhandled", { error: String(err?.message || err) });
    res.status(500).json({ ok: false, error: "internal error" });
  });
  return app;
}

export const defaultConnectors = {
  feed: (cfg) => fetchFeedItems(cfg),
  csv: async (cfg) => parseCsvItems(cfg.csv_text),
  website: (cfg) => crawlSiteItems(cfg, { delayMs: 300 }),
  database: (cfg) => fetchDbItems(cfg),
};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const config = loadConfig();
  const logger = createLogger();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, "kb-bridge.db"));
  const app = buildApp({ db, config, logger, connectors: defaultConnectors });
  const scheduler = startScheduler({ db, config, logger, connectors: defaultConnectors });
  const server = app.listen(config.port, () => logger.info("kb-bridge listening", { port: config.port, mock: config.mockAssistable }));
  const shutdown = () => {
    logger.info("shutting down");
    scheduler.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

(Fix the obvious redundancy while implementing: build the connectors object once and pass the same reference to both `buildApp` and `startScheduler`.)

- [ ] **Step 4: Run FULL suite** — `npm test` → ALL PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: server wiring, helmet/CSP, rate limits, graceful shutdown"`

---

### Task 15: E2E smoke + README + runbook

**Files:**
- Create: `test/e2e.test.js`, `README.md`
- Test: `test/e2e.test.js`

**Interfaces:** Consumes the whole stack via `startTestApp` (Task 13 helper) — no new exports.

- [ ] **Step 1: Write the E2E test** — full journey in MOCK mode:

```js
// test/e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

test("full journey: signup -> connect -> csv source -> tool call answers Tacoma question", async () => {
  const t = await startTestApp();
  const hdrs = (cookie) => ({ "content-type": "application/json", "x-requested-with": "kb-bridge", ...(cookie ? { cookie } : {}) });

  let res = await fetch(`${t.base}/signup`, { method: "POST", headers: hdrs(), body: JSON.stringify({ email: "dealer@riva.com", password: "longenough1" }) });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  await fetch(`${t.base}/connect`, { method: "POST", headers: hdrs(cookie), body: JSON.stringify({ api_key: "ak-real-looking" }) });

  res = await fetch(`${t.base}/sources/new`, { method: "POST", headers: hdrs(cookie), body: JSON.stringify({
    type: "csv", name: "Riverside Inventory", schedule_minutes: 1440,
    csv_text: [
      "make,model,year,price,mileage,vin,color",
      'Toyota,Tacoma,2022,"$28,500",31000,VIN001,Silver',
      'Toyota,Tacoma,2021,"$26,900",44000,VIN002,Red',
      'Toyota,Tundra,2023,"$41,000",12000,VIN003,Black',
    ].join("\n"),
    assistant_ids: ["mock-assistant-1"],
  })});
  const { source_id } = await res.json();

  const source = t.db.prepare("SELECT secret FROM sources WHERE id=?").get(source_id);
  // Simulate Assistable's proxy calling the tool exactly per platform contract
  res = await fetch(`${t.base}/api/tools/${source_id}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": source.secret, location_id: "loc1", assistant_id: "a1", call_control_id: "cc1", direction: "inbound" },
    body: JSON.stringify({
      args: { query: "do you have a 2022 tacoma under 30k", make: "Toyota", model: "Tacoma", price_max: 30000, price_min: 0, year_min: 2022, year_max: 2022 },
      meta_data: { tool_id: "t1" }, metadata: {}, call: { call_id: "cc1", retell_llm_dynamic_variables: {} },
    }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.result_count, 1);
  assert.equal(out.items[0].price, 28500);
  assert.match(out.speech_hint, /Tacoma/i);
  assert.ok(JSON.stringify(out).length < 1600, "voice-sized response");
  t.srv.close();
});
```

- [ ] **Step 2: Run** — PASS.
- [ ] **Step 3: Write README.md** covering: what it is (one paragraph + the static-KB comparison table from Platform Contract fact #7), quickstart (`cp .env.example .env`, set ENCRYPTION_KEY, `npm i && npm start`), MOCK vs live mode, how tool provisioning works, the voice re-save caveat, security model summary (tenant isolation, encrypted secrets, SSRF guard, webhook secret, 200-always contract), backup/restore (`data/backups/`, restore = stop, replace `kb-bridge.db`, start), and the **integration checklist for going live**: (1) set `MOCK_ASSISTABLE=0` + real `BASE_URL` (must be public HTTPS), (2) verify which auth header the v3 API honors (Authorization Bearer vs x-api-key) with Hari's key and drop the unused one in `client.js`, (3) create one real tool against a test assistant, run a live voice call asking the Tacoma question, confirm sub-2s answer, (4) check `tool_calls` log.
- [ ] **Step 4: Full suite green** — `npm test` → ALL PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: e2e smoke + README with go-live checklist"`

---

## Self-Review Checklist (run after Task 15)

1. **Spec coverage:** every spec section maps to a task (connectors T7-8, scheduler/reliability T9, search T10, provisioning T11, webhook T12, dashboard T13, security T2/T4/T5/T14, testing T15). KB-sync mode intentionally out (spec v2).
2. **Platform contract honored:** envelope parsing (T12), 200-always (T12), 404 non-retried auth failure (T12), flat forced-required-safe schema with sentinels (T11), voice re-save notice (T13), 429 backoff + 409 rename (T11).
3. **Security test presence:** IDOR (T5+T13), CSRF (T5+T13), SSRF incl. rebinding (T4), secret non-echo (T13), tamper detection (T2), redaction (T1).
4. **Type consistency:** `ownedSource(db,userId,id)`, `runSync(deps,id,opts)`, `searchStructured(db,source,args)`, `buildToolResponse({source,structured,textResult,args,tookMs})`, `buildToolDefinition(source,columnMeta,{baseUrl,secret})` — signatures identical wherever referenced.
