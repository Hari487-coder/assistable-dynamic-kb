# KB Bridge — Live Knowledge Base for Assistable AI agents

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Hari487-coder/assistable-dynamic-kb)

A standalone multi-tenant portal that gives Assistable voice + chat agents
**live data** through custom tools. Users sign up, connect their Assistable v3
API key, add a dynamic source (CSV / feed URL / website / Postgres), and the
portal auto-creates a tool in their Assistable account. When a caller asks
"do you have a 2022 Tacoma under $30k?", the agent calls this service and
answers from data synced minutes ago — with real filters, not vector guesses.

Zero-cost by design: Node built-in SQLite (FTS5/BM25), no external services on
the hot path, no paid APIs. See `docs/2026-07-13-live-kb-master-implementation-guide.md`
for the full production architecture and `docs/superpowers/` for spec + plan.

## Why not the static KB?

| | Assistable static KB | KB Bridge |
|---|---|---|
| Freshness | Frozen at upload; re-upload duplicates | Re-synced on schedule + "Sync now"; atomic swap + rollback |
| "Tacoma under $30k" | Cosine similarity over text chunks | Real `price <= 30000` SQL filter |
| CSV / inventory | Chunked as blind text, rows severed | One item per row, typed columns |
| No match | Injects 3 least-bad chunks anyway | "No exact match, closest is…" + alternatives |
| Voice | Top-6 chunks, $0.01/query | Pre-composed `speech_hint`, ~30-60ms |

## Deploy your own (plug-and-play)

Each user can run their **own** instance — own data, own URL, first signup
claims it, encryption key auto-generates. Three zero-cost paths (Render
blueprint / Docker / Oracle free VM): see **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

## Quickstart (local dev)

```bash
cp .env.example .env
# set ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm install
npm start          # http://localhost:3900
node --test test/  # run the suite
```

`MOCK_ASSISTABLE=1` (default) logs v3 API calls instead of sending them — the
whole flow works end-to-end locally with a mock assistant.

## How it works

1. **Sign up → Connect** — paste an Assistable v3 API key (verified via
   `GET /v3/assistants`, then AES-256-GCM encrypted at rest, never shown again).
2. **Add a source** — CSV upload, feed URL (JSON/CSV/XML), website crawl, or
   Postgres/Supabase (read-only SELECT). The sync engine ingests into a new
   batch, validates it (shrink guard), and atomically swaps it live. Column
   types are inferred (numeric / categorical / text).
3. **Tool provisioning** — a `live_data_<name>` tool is created in the user's
   Assistable account (channel-less: serves BOTH voice and chat automatically)
   with a flat, stable parameter schema generated from the columns, pointing at
   `POST {BASE_URL}/api/tools/{sourceId}/search` with a per-source secret header.
4. **Agents call it live** — the webhook parses Assistable's envelope
   (`{args, meta_data, metadata, call}`), runs structured filter search with
   alias/fuzzy resolution and tiered relaxation (or BM25 for website sources),
   and returns a compact JSON with `speech_hint`, citations (`as_of`,
   freshness), and never a bare "no results".

### The webhook contract (non-negotiable, verified against platform source)

- Always **HTTP 200** for handled outcomes (the platform proxy retries 5xx/429
  while the caller waits in silence); **404 only** for bad/missing secret
  (4xx is not retried).
- Answer fast: internal deadline 2.5s, typical ~30-60ms. Voice budget is 10s
  total round trip through Telnyx + the proxy.
- Response ≤ ~1200 chars; `speech_hint` is what the voice model reads aloud.

## Onboarding checklist for a real customer

1. Deploy with a public HTTPS `BASE_URL` and `MOCK_ASSISTABLE=0`.
2. Connect their v3 API key; add a source; pick their assistants.
3. Verify which auth header the v3 API honors (the client sends both
   `Authorization: Bearer` and `x-api-key`; drop the unused one in
   `src/assistable/client.js` after the first live test).
4. If the assistant has a static KB covering the same domain, unlink those
   docs — the voice knowledge_base tool competes ("only source of truth").
5. Paste the prompt snippet into the assistant instructions:
   > For ANY question about {domain}, ALWAYS call {tool name} first and answer
   > only from the result. If it returns nothing, say you don't have that
   > information. When a speech_hint is present, read it aloud.
6. Make a live voice call and ask the Tacoma question. Check the source's
   detail page: sync history, recent agent queries, unanswered queries.
7. Note: voice agents cache the tool schema at assistant-save. After schema
   changes, re-save the assistant in Assistable (the portal shows a banner).

## Security model

- Tenant isolation: every source access goes through `ownedSource(db, userId, id)`
  — IDOR-tested; per-user rows only.
- Secrets: Assistable keys + source configs (DB creds) AES-256-GCM encrypted;
  logger redacts key-like fields; keys never rendered back to the browser.
- Webhook auth: per-source 32-byte secret, constant-time compare, 404 on fail;
  per-source soft rate limit (60/min, JSON error — never HTTP 429).
- SSRF: all user-supplied URLs resolve-then-verify against private ranges with
  connect-time IP pinning (undici Agent), redirect re-validation, size/time caps.
- Sessions: bcrypt(12), hashed tokens, httpOnly SameSite cookies; CSRF via
  custom-header check; login rate limits; append-only audit log.
- SQL: JSON paths bound as parameters (column names are tenant data); FTS
  match expressions built from sanitized tokens only.

## Operations

- Backups: daily `VACUUM INTO data/backups/kb-YYYY-MM-DD.db` (keep 7) from the
  in-process scheduler. Restore = stop, replace `data/kb-bridge.db`, start.
- Crash recovery: heartbeated sync runs; stuck runs marked failed on boot;
  a failed sync never touches the currently-served batch; one-click rollback.
- Health: `GET /healthz`. Logs: JSON lines on stdout.

## Layout

```
src/
  server.js            wiring, helmet/CSP, rate limits, graceful shutdown
  config.js logger.js crypto.js db.js ssrf-guard.js auth.js tenant.js
  ingest/normalize.js  numeric parsing, column inference
  connectors/          csv, feed, website, database
  sync/engine.js       scheduler, atomic batch swap, retry ladder, backups
  search/              structured (filters+relaxation), text (BM25), respond
  assistable/          v3 client (mock mode), tool definition builder
  routes/              tool-api (the webhook), dashboard
  views/pages.js       server-rendered HTML
test/                  node:test suites + fixtures (54 tests)
```
