# Live KB: end-to-end flow

How everything works from first click to a live phone answer, with the file and
function behind each step. Grounded in the code, not a pitch.

```
Owner                          Their Live KB instance                 Assistable
─────                          ──────────────────────                 ──────────
 Deploy free ───────────────►  first boot: keygen + DB
 sign up (claims instance)     signups close
 paste API key ─────────────►  verify + encrypt ────────────────────► GET /v3/assistants
 add data + pick assistants ─► sync → tool-def ───────────────────►  POST /v3/tools + assign
 (copy prompt snippet into their assistant)
                                                     caller on a call ◄─── "2022 Tacoma under 30k?"
                               /api/tools/:id/search ◄──────────────── tool proxy (envelope)
                               search (~16ms) ─────────────────────►  agent speaks the answer
 watch it in the query log  ◄─ tool_calls logged
```

## 1. Discover and deploy (about five minutes)

1. **Landing page** `landing/index.html` (served by GitHub Pages via
   `.github/workflows/pages.yml`). One button: **Deploy free**.
2. Render reads **`render.yaml`** and creates the owner's own instance from the
   public repo. First boot, `src/server.js`:
   - loads `.env` if present, then `loadConfig(process.env, { autoKey: true })`.
   - `resolveEncryptionKey()` (`src/config.js`) generates a 32-byte AES key and
     writes it to `data/.encryption-key` so every later restart can still
     decrypt. `BASE_URL` falls back to `RENDER_EXTERNAL_URL` (zero config).
   - `openDb()` (`src/db.js`) opens SQLite in WAL, applies the schema, runs the
     idempotent `migrate()`.
   - `startScheduler()` begins the 30s sync tick.
3. **Sign up** at `/signup`. With `SIGNUPS=first-only` the first account claims
   the instance; every later signup gets a 403 (`signupsClosed()` in
   `routes/dashboard.js`). Password is bcrypt(12); the session token is random,
   sha256-hashed in `sessions`, set as an httpOnly SameSite cookie. Redirects
   to `/setup`.

## 2. Connect Assistable

4. **Connection page** `/connect`. Owner pastes their v3 API key, plus a
   Subaccount / Location ID if the key covers more than one subaccount.
   - `AssistableClient.verifyConnection()` (`src/assistable/client.js`) calls
     `GET /v3/assistants` with `Authorization: Bearer <key>` and, when set,
     `X-Subaccount-Id`. (Verified against platform source: Bearer is the only
     accepted auth header; every v3 route runs `requireSubAccount`.)
   - On success the key is AES-256-GCM encrypted into `connections.api_key_ct`,
     and the subaccount id stored. The key is never rendered back to the page.
   - On failure `explainAssistableError()` returns the real reason (revoked,
     wrong subaccount, missing scope, unreachable, wrong API base), shown inline.
   - Scopes it needs, and no others: `assistants:list`, `tools:create`,
     `tools:update`, optionally `tools:delete`.

## 3. Add data, and auto-provision the tool

5. **Add source** `POST /sources/new`. Owner picks a type (csv / feed / website
   / webtable / database), names it, ticks which assistants should answer from
   it. The handler mints a per-source `secret` (the tool's `x-bridge-secret`)
   and a `push_secret`, encrypts the connector config into `config_ct`, and
   inserts the `sources` row.
6. **First sync runs immediately** — `runSync(deps, id, { manual: true })`
   (`src/sync/engine.js`):
   - the connector fetches (`connectors/*.js`, each behind the SSRF guard for
     URL sources).
   - `inferColumnMeta()` (`src/ingest/normalize.js`) classifies every column as
     numeric, categorical (frequency-ordered, label-sized only) or text, and
     `rowToItem()` builds a speakable title plus a searchable body.
   - rows are written under a fresh `batch_id`, gated (>=1 row; shrink guard vs
     the previous batch; 50k cap), then the batch is swapped in one transaction
     (`prev_batch_id` kept for rollback). Items land in `items`, indexed by the
     `items_fts` FTS5 table via triggers.
7. **Tool created in the owner's Assistable account**:
   - `buildToolDefinition(source, columnMeta, { baseUrl, secret })`
     (`src/assistable/tool-def.js`) produces a flat, provider-safe JSON schema:
     a free-text `query` plus up to six typed filters drawn from the columns
     (categoricals as enums, numerics as `_min` / `_max`), with sanitized
     parameter names, `tool_type: "FUNCTION"`, `category: "custom"` (so the
     owner can edit it in Assistable), and `headers: { x-bridge-secret }`.
     `url` points at `POST {BASE_URL}/api/tools/{sourceId}/search`.
   - `client.createTool(def)` then `assignTool(toolId, assistantId)` per ticked
     assistant. There is no channel field on Assistable tools, so one tool
     serves both voice and chat automatically. Result stored in `tools`.
8. Owner copies the **prompt snippet** into their assistant, and tests in the
   **Try-it box** (`POST /sources/:id/test`, same engine, session-authed).

## 4. A live call (the point of the whole thing)

9. A caller asks: *"do you have a 2022 Tacoma under thirty thousand?"* The
   Assistable LLM decides to call the tool. Assistable's **tool proxy** POSTs
   the envelope `{ args, meta_data, metadata, call }` to
   `POST /api/tools/:sourceId/search` with the `x-bridge-secret` header.
10. `createToolApiRouter` (`src/routes/tool-api.js`) handles it:
    - constant-time compare of the secret; **404 (empty) on failure** — the only
      non-200 response, because the proxy retries 5xx/429 and would hang the call.
    - a 60s result micro-cache keyed on `sourceId + active_batch_id + callId +
      hash(args)` absorbs the proxy's retry storm and repeated questions; a sync
      swap invalidates it automatically.
    - envelope-parse: use `body.args` when `meta_data`/`metadata`/`call` are
      present, else the body itself.
    - conversation memory (keyed on `call_control_id`, 10-min TTL) lets a
      follow-up like "what about the 2021?" inherit the call's earlier filters.
11. `searchStructured()` (`src/search/structured.js`):
    - `deriveIntent()` recovers filters from raw text the LLM did not type:
      numeric bounds ("under 30k"), year, sort ("cheapest"), and the tenant's
      own category values ("bright copper", "London"). Explicit LLM filters
      always win; every derivation is disclosed in `relaxations`.
    - categoricals resolve exact -> case-insensitive -> alias -> edit-distance
      fuzzy; a zero-result spelling is retried against the FTS vocabulary.
    - two-stage retrieval: FTS5/BM25 gives up to 500 ranked candidate rowids,
      then the JSON filters run only on those rows (keeps p95 ~16ms at 5k rows).
    - tiered relaxation if empty: widen numeric bounds +-15% -> drop the least
      selective filter -> keyword-only. It never returns a bare "no results";
      it returns labelled `close_alternatives`.
12. `buildToolResponse()` (`src/search/respond.js`) returns compact JSON:
    `result_count`, `items`, `applied_filters`, `relaxations`, `as_of`,
    `data_freshness`, and a `speech_hint` composed from the item title and its
    money column (correct currency inferred from the column name). Always HTTP
    200. Chat reads the JSON; voice reads the `speech_hint` aloud.
13. The call is written to `tool_calls` with an `outcome`
    (answered / alternatives / weak / no_match / browse / error) and `flags`
    (spell, qualitative, context, relaxed, cached, stale_data) by
    `classifyOutcome` / `callFlags` (`src/analytics/quality.js`).

## 5. Stay fresh, prove it, stay reliable

14. **Freshness.** The in-process scheduler re-syncs sources whose
    `next_run_at` is due (30s tick, jittered, max 2 concurrent). A content hash
    skips re-embedding unchanged data. For live pricing, the owner's own system
    calls `POST /api/push/:id/refresh` or `/content` (authenticated by the
    separate `push_secret`) for second-level updates. A failed or suspicious
    sync never touches the batch currently serving answers; one-click rollback
    is on the source page.
15. **Proof.** The source detail page shows a plain-language quality panel
    (`qualitySummary` in `src/analytics/quality.js`): help rate, dead-end rate,
    latency percentiles, and the exact questions callers asked. The dead-end
    rate is the number that decides whether a local semantic-search fallback is
    ever worth adding.
16. **Reliability.** Daily `VACUUM INTO` backups (kept 7) plus a one-click
    backup download; boot-time recovery of crashed syncs; log retention
    (`tool_calls`/`sync_runs` 90d, audit 180d). Render's free disk is ephemeral
    (documented); the Oracle always-free VM path (`deploy/oracle-setup.sh`) is
    the durable, still-$0 production home.

## Security posture in one place

- Tenant isolation: every source access goes through `ownedSource(db, userId,
  id)`; IDOR-tested.
- Secrets at rest: Assistable keys and connector configs AES-256-GCM encrypted;
  the logger redacts key-like fields; keys never re-rendered.
- Webhook auth: per-source 32-byte secret, constant-time compare, 404 on fail,
  soft per-source rate limit (never a hard 429 on the hot path).
- SSRF: every user-supplied URL is resolve-then-verified against private ranges
  with connect-time IP pinning, redirect re-validation, and size/time caps.
- Sessions: bcrypt(12), hashed tokens, SameSite cookies, custom-header CSRF,
  login rate limits, append-only audit log.
- SQL: JSON paths bound as parameters (column names are tenant data); FTS match
  expressions built from sanitized tokens only.

## Cost

Zero to run: Node built-in SQLite (no DB server), no vector store, no paid APIs,
free hosting tiers. The no-network-call hot path is also why a lookup is ~16ms.
