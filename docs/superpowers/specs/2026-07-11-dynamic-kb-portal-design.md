# Dynamic KB Portal ("KB Bridge") — Design Spec

Date: 2026-07-11
Status: Approved by Hari (design), pending spec review
Location: `Case Study/assistable-dynamic-kb`

## Problem

Assistable's knowledge bases are static: sources are embedded once (text/FAQ/URL/file)
and never refreshed. Customers with data that changes daily — the canonical case is a
car dealership's vehicle inventory — cannot keep their AI agents accurate in voice or
chat.

Two facts verified in the platform source (`Case Study/_assistable-code`) shape this
design:

1. **The public v3 API cannot produce a working KB source.** `POST
   /v3/knowledge-bases/:id/sources/*` records the row with `status: PENDING` and
   explicitly does not run the embedding pipeline
   (`be/.../packages/api/src/routes/v3/knowledge.ts:282-284`). No cron or worker in
   either repo sweeps PENDING rows; only the v2 UI's tRPC mutations trigger the
   Upstash processing workflow at create time
   (`v2/.../src/server/api/routers/knowledge/index.ts:359-403`), and the
   `retrySource` rescue is session-authed tRPC. Sources created via API sit
   unembedded forever. (Separately worth filing as a platform bug.)
2. **The custom-tool system already supports live external lookups on both
   channels.** Tools carry `url`, `httpMethod`, `headers`, JSON-schema `parameters`,
   a `ToolChannel` of `CHAT | VOICE | BOTH`, and voice custom tools are HTTP webhooks
   (`be/.../packages/db/prisma/schema/models/tool.model.prisma`). Tool CRUD +
   assistant assignment are available through the v3 API / Assistable MCP.

Therefore: **v1 delivers dynamic data via live tool lookup, not KB writes.** For
structured inventory this is also strictly better than re-embedded vectors — a
structured query answers "2022 Tacoma under $30k" correctly and is never stale.

## What it is

A standalone multi-tenant web portal. A user:

1. Creates an account (email + password).
2. Connects their Assistable account by pasting their v3 API key.
3. Adds one or more **dynamic sources** (website / feed URL / CSV / database).
4. Picks which assistants should be able to query each source.

The portal then:

- Ingests the source into its own store and **rescans on a schedule** (daily
  default, per-source configurable, plus a "Sync now" button).
- **Auto-creates a custom tool** in the user's Assistable account pointing at the
  portal's search endpoint, and assigns it to the chosen assistants (channel
  `BOTH`), so agents fetch current data mid-call and mid-chat.

## Connectors (v1)

| Connector | Config | Refresh |
|---|---|---|
| Website | Start URL(s); same-domain crawl, depth + page caps, robots.txt respected | Scheduled rescan |
| Feed URL | HTTP(S) endpoint returning JSON, CSV, or XML; optional auth header | Scheduled poll |
| CSV upload | File upload; re-upload replaces data | Manual |
| Database | Postgres connection string, or Supabase URL + key; table/view name | Scheduled query |

Out of scope for v1: Google Sheets OAuth (published-CSV links already work via Feed
URL), direct DMS connectors (vAuto, HomeNet), KB-sync mode (gated on the platform
fix for PENDING processing), billing.

## Architecture

Node.js + Express + better-sqlite3, single process. Server-rendered pages via
plain JS template-literal functions + minimal vanilla JS. No build step, no
template engine dependency. Same family as
attribution-bridge. Deployable to Render later; runs locally first.

Components:

- **Web app** — signup/login (bcrypt, session cookie), dashboard: Assistable
  connection, source CRUD, assistant picker, sync history, test-search box.
- **Ingestion workers** — per-connector `fetch → normalize → store`, run by an
  in-process scheduler loop (setInterval tick, per-source `next_run_at`).
- **Search API** — `POST /api/tools/:sourceId/search`. This is the endpoint the
  Assistable tool calls during conversations. Authenticated by a per-source secret
  header configured on the tool at creation. Local-DB search only; target well
  under 1s (voice latency budget).
- **Assistable client** — thin v3 API wrapper: create/update tool, assign/remove
  tool on assistants, list assistants. `MOCK=1` mode logs payloads instead of
  calling out, for development and tests.

### Data model (SQLite)

- `users` (id, email, password_hash, created_at)
- `assistable_connections` (user_id, api_key_encrypted, subaccount label, status)
- `sources` (id, user_id, type, name, config_json, schedule, secret, status,
  last_sync_at, next_run_at)
- `items` (id, source_id, title, body, structured_json, updated_at) + FTS5 index
  over title/body
- `sync_runs` (source_id, started_at, finished_at, ok, items_count, error)
- `tools` (source_id, assistable_tool_id, assistant_ids_json)

## Ingestion & search

One `items` table, two data shapes:

- **Structured** (feed/CSV/DB rows): each row stored with its columns in
  `structured_json`. At source creation the portal detects columns and generates
  the tool's parameter schema (e.g. `query`, `max_price`, `year`, `make`, generic
  `filters`) and a tool description that tells the LLM what it can filter on.
  Search maps parameters to SQL over `json_extract` columns, returns top N rows as
  compact JSON.
- **Unstructured** (website pages): cleaned text, chunked (~1-2k chars), FTS5/BM25
  keyword search returns top chunks; the agent answers from them (RAG at call time,
  no embeddings, zero cost).

Sync is replace-on-success: new items land in a staging batch; on success the old
batch for that source is swapped out atomically. A failed sync never wipes
yesterday's data.

## Security

- Assistable API keys and DB credentials encrypted at rest (AES-256-GCM, key from
  env `ENCRYPTION_KEY`); write-only in the UI (never rendered back).
- Search endpoint requires the per-source secret header; requests without it get
  404 (not 401, to avoid confirming source existence).
- DB connector is read-only by construction: single templated `SELECT` on the
  configured table/view (no raw SQL from config), statement timeout, row cap.
  Recommend read-only credentials in the UI copy.
- Crawler: robots.txt, same-domain only, max pages/depth, request timeout, polite
  delay.
- Sessions: httpOnly secure cookies; passwords bcrypt(12); rate limit on auth
  endpoints.

## Error handling & observability

- Every sync writes a `sync_runs` row; dashboard shows last-run status and error
  message per source. 3 consecutive failures → source flagged `stale` in UI.
- Search endpoint always answers within budget: on internal error it returns a
  structured `{ error: "temporarily_unavailable" }` so the agent can say so
  gracefully rather than time the call out.
- Tool creation failures surface immediately in the UI with the Assistable API
  response.

## Testing

- Unit: each connector against fixtures (JSON/CSV/XML feeds, saved HTML pages,
  seeded Postgres via a stub); param-schema generation; search filter mapping.
- E2E smoke (MOCK mode): signup → connect → add CSV source → sync → search endpoint
  returns correctly filtered results → tool-creation payload asserted.
- One real-account integration pass with Hari's Assistable key before any external
  user.

## v2 (later, separate specs)

- **KB-sync mode** once the platform PR lands that makes v3-created sources process
  (fix belongs in `assistable-buildship-replacement-be` / `assistable-v2`: trigger
  the processing workflow from the v3 source routes, or add a PENDING sweeper).
- Direct DMS/API connectors; Google Sheets OAuth; per-user usage metrics; billing.
