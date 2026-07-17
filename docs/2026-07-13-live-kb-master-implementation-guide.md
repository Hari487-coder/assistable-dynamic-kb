# Live KB — Master Implementation Guide (Standalone Product)

**Status:** v2.0 — 2026-07-13 (v1 was platform-native; superseded — we cannot code
Assistable's backend, so the Live KB is a **standalone product**. v1 is in git history.)
**What it is:** a multi-tenant Live Knowledge Base SaaS. Assistable customers sign
up, connect their data, and their AI agents (voice + chat) call our tool endpoint
in real time to answer from trusted, current knowledge.
**Integration surface:** Assistable custom tools only — provisioned through the
public v3 API with the customer's own key, invoked by the platform's tool proxy
during conversations. Every fact about that surface below is verified in the
platform source (`Case Study/_assistable-code`, cited as `repo path:line`).
**Hard constraint: $0 run cost.** No paid APIs (no OpenAI embeddings), no paid
databases, no paid hosting. Every component below is free-tier or self-hosted
free software, and the hot path is engineered to need **zero external calls** —
which is simultaneously the cheapest and the fastest design. Paid upgrades are
listed only as explicit revenue-gated triggers (§17).

---

## 0. Product shape in one page

```
 Customer                        Live KB (our product)                    Assistable
┌──────────┐  signup/connect   ┌──────────────────────────┐   v3 API    ┌──────────────┐
│ Dealer / │ ───────────────►  │ Portal (web app)         │ ──────────► │ creates tool │
│ Ecom /   │  add sources      │  KBs · sources · tools   │  customer's │ assigns to   │
│ Services │                   │  analytics · billing     │  API key    │ assistants   │
└──────────┘                   ├──────────────────────────┤             └──────┬───────┘
      docs/PDF/site/FAQ/       │ Ingestion pipeline       │                    │ caller asks
      feed/CSV/DB/push  ─────► │  version → chunk → index │             ┌──────▼───────┐
                               ├──────────────────────────┤  tool call  │ voice / chat │
                               │ Retrieval engine         │ ◄────────── │ agent (via   │
                               │  hybrid + structured     │  webhook    │ tool proxy)  │
                               │  citations + confidence  │ ──────────► │ speaks answer│
                               └──────────────────────────┘  ≤400ms     └──────────────┘
```

- The agent treats our endpoint as a tool: `knowledge_lookup` (semantic) and/or
  `search_inventory`-style typed tools (structured). One tool works on **both**
  voice and chat automatically — the platform has no channel field; every
  assistant-linked FUNCTION/CUSTOM tool ships to both surfaces (verified:
  `ToolChannel` enum is dead code, `be/.../telnyx-tool-translator.ts:878`,
  `tool.model.prisma:11-15`).
- We never touch Assistable's backend. We provision tools with the customer's
  key (`POST /v3/tools`, `POST /v3/tools/:id/assign`) and serve the webhook.
- The static KB stays whatever it is; our product wins by being **live,
  filterable, cited, and honest** — and by the onboarding step that tells the
  agent to prefer us (§12).

---

## 1. The integration contract (verified — build against this, not hope)

These are the physics of our world; every design choice downstream honors them.

1. **Who calls us:** Assistable's backend proxy (`executeProxiedTool`) for BOTH
   channels — voice goes Telnyx → their proxy → us; chat calls the same function
   in-process (`be/.../services/tool-proxy.service.ts:481-534`, `agent-run.ts:345-371`).
2. **Request:** `POST`, JSON envelope `{args: <LLM args>, meta_data:{tool_id,
   location_id, contact_id, assistant_id, to, from, direction}, metadata:<same>,
   call:{call_id}}`. `executionType` is not settable via API → always envelope;
   parse defensively (accept raw args). Context arrives as HTTP headers
   (`location_id`, `assistant_id`, `call_control_id`, `direction`; `contact_id`
   missing on ~8-17% of voice calls). Our secret header from the tool's
   `headers` map arrives verbatim (`tool-proxy.service.ts:415-507`).
3. **Time & retries:** Telnyx gives the whole round trip **10s**; the proxy
   fetch is 15s × up to 4 attempts and **retries 5xx and 429**
   (`be/.../lib/http.ts:37-100`, translator `:627`). Therefore: p95 ≤ 400ms,
   hard deadline 2.5s, **always HTTP 200** with error JSON for handled failures;
   404 (not retried) only for auth failure. Never 5xx, never 429 on the hot path.
4. **Response handling:** chat feeds `JSON.stringify(body)` to the LLM
   untruncated; voice wraps as `{return: body}`. Keep ≤ ~1200 chars, include a
   `speech_hint` the voice model can read aloud (`tool-proxy.service.ts:558-618`).
5. **Tool schema:** all top-level params are FORCED required on both channels
   (`telnyx-tool-translator.ts:601-605`; chat tool-loader same policy) → flat,
   stable schema with `""`/`0` = "not specified" sentinels. Voice bakes
   name/description/params at assistant-save; URL/header changes apply per-call
   (`telnyx-agent.ts:44`) → schema churn requires customer re-save; keep schema
   stable, put changing vocabulary in descriptions.
6. **Provisioning API:** `POST /v3/tools` (name `^[a-zA-Z0-9_-]{1,64}$`, 409 on
   dup), `PATCH` fully replaces headers/params, assign/remove per assistant,
   `GET /v3/assistants` for the picker (omit `include_archived` — coerce-boolean
   footgun). Envelope `{data,error,request_id}`; limits 150 req/10s + 100k/day
   per workspace+subaccount (`be/.../routes/v3/tools.ts`, `_schemas.ts:615`,
   `rate-limit-config.service.ts:20-22`). Tool headers are stored plaintext and
   readable with `tools:READ` — our per-source secrets must be revocable and
   low-privilege (scoped to one source's search only), which they are by design.
7. **What we're beating:** static KB = embed-raw-query → Pinecone top-3 (chat) /
   top-6 (voice, $0.01/query), no score floor, CSV chunked as blind text, no
   refresh path (`agent-run.ts:957-999`, `routes/knowledge-base.ts:64-144`,
   v2 `chunking.service.ts:17`, `knowledge-processor.service.ts:104,347`).

---

## 2. Goals, non-goals, SLOs

**Goals**
- G1. Freshness ≤ 60s for push sources; schedule-bound for pull; per-answer `as_of`.
- G2. Structured questions answered structurally; unstructured via hybrid
  retrieval with confidence floor + citations; explicit `answerable:false`.
- G3. Webhook p95 ≤ 400ms; hard 2.5s degraded response; 200-always.
- G4. Scale: 5,000 tenants, 5M chunks, 200 tool calls/s, without re-architecture.
- G5. Zero cross-tenant reads, provable by test.
- G6. Self-serve onboarding end-to-end in < 15 minutes.

**Non-goals (v1):** editing documents in-app; cross-tenant shared knowledge;
per-tenant embedding models; mobile app.

**SLOs:** availability 99.9% (hot path); webhook p95 ≤ 400ms; ingest freshness
p95 ≤ 60s (push); RPO ≤ 5min / RTO ≤ 30min.

---

## 3. Architecture & stack

**Stack — everything $0, chosen so the hot path makes zero external calls:**
- **App:** Node 22, Express, plain ESM JS — exactly the built KB Bridge plan.
  ONE process: web + webhook + in-process sync scheduler (no separate worker
  fleet — it must fit one free machine).
- **Database:** **SQLite (better-sqlite3, WAL) is the production database**,
  not just the MVP one. Zero cost, zero cold starts, microsecond reads, FTS5
  BM25 built in, backups are file copies. A Postgres seam is retained in
  `db.js`/`search/` but migration is a **revenue-gated trigger** (§17), not a
  roadmap item.
- **Semantic search (optional, still $0):** local embeddings via
  `fastembed-js` (or transformers.js) running `all-MiniLM-L6-v2` (384-d,
  Apache-2.0) on CPU + `sqlite-vec` for ANN — no API, no spend. Ship
  **BM25-first**; enable local vectors per-KB when quality demands (§7.2).
  CPU query-embed cost ≈ 20-60ms on a 4-core box — inside budget.
- **Cache/queues:** none external. In-process LRU for query results and
  embeddings; the MVP plan's SQLite-backed scheduler with heartbeats does jobs.
  No Redis anywhere.
- **Files:** local disk (`data/files/`), originals kept for re-processing;
  optional nightly `rclone` of backups to a free-tier bucket (Cloudflare R2
  10GB free) — free-tier, not paid.
- **Hosting ($0 AND always-on — the crux, because a cold start blows the 10s
  voice budget):**
  1. **Recommended: Oracle Cloud Always Free ARM (A1)** — up to 4 OCPU / 24GB
     RAM, free forever, a real always-on VM with no idle spin-down. Caddy for
     automatic TLS + a free hostname (DuckDNS) or any owned domain. This is the
     production home.
  2. **Pilot-simple: Render free web service** — free stable
     `*.onrender.com` HTTPS URL, but idles after 15min; pair with a free
     uptime pinger (UptimeRobot, 5-min interval) to stay warm. Fine for design
     partners; not for paying customers (rare cold starts remain).
  3. **Dev/demo:** Cloudflare Tunnel from any machine.
- **Errors/observability:** JSON logs to disk + logrotate; free Sentry
  developer tier or the existing self-hosted GlitchTip — both $0. UptimeRobot
  free for external uptime alerts.

**Why this wins on latency too:** the BM25 + structured hot path is SQLite
reads and in-process code — **no network call leaves the box** during a tool
call. Server-side p95 lands ~10-50ms, an order of magnitude inside the budget,
because the $0 design and the fast design are the same design.

---

## 4. Data model

> **DDL note:** the logical model below is written in Postgres syntax for
> precision, but **production runs it on SQLite**: `UUID`→`TEXT`
> (crypto.randomUUID), `TIMESTAMPTZ`→ISO-8601 `TEXT`, `JSONB`→`TEXT` +
> `json_extract`, `TSVECTOR/GIN`→an `items_fts` FTS5 contentless table with
> sync triggers (exactly as in the MVP plan), `VECTOR`→`sqlite-vec` virtual
> table (only when local embeddings are enabled), arrays→JSON text. The
> Postgres form becomes literal only if the revenue-gated migration (§17) ever
> fires.

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE assistable_connections (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_ct TEXT NOT NULL,            -- AES-256-GCM envelope, never plaintext
  status TEXT NOT NULL DEFAULT 'unverified', updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE kbs (                      -- a customer groups sources into KBs
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL, kb_id UUID NOT NULL REFERENCES kbs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('file','url','website','faq','text','feed','csv','database','push')),
  name TEXT NOT NULL,
  config_ct TEXT NOT NULL,             -- encrypted connector config (creds live here)
  schedule_minutes INT,                 -- null = push/manual
  secret TEXT NOT NULL,                 -- per-source webhook auth (tool header)
  push_hmac_secret TEXT,                -- for inbound push signatures
  status TEXT NOT NULL DEFAULT 'never_synced'
    CHECK (status IN ('never_synced','syncing','active','stale','error')),
  active_version_id UUID, prev_version_id UUID,
  column_meta JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] NOT NULL DEFAULT '{}',
  next_run_at TIMESTAMPTZ, last_sync_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE source_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version_num INT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building','active','superseded','failed','rolled_back')),
  item_count INT, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), activated_at TIMESTAMPTZ,
  UNIQUE (source_id, version_num)
);
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,                  -- DETERMINISTIC: {version_id}_{idx} (idempotent re-runs)
  version_id UUID NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL, kb_id UUID NOT NULL, source_id UUID NOT NULL,
  chunk_index INT NOT NULL,
  text TEXT NOT NULL, heading_path TEXT,
  embedding VECTOR(1536),
  tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  structured JSONB,                     -- row payload for structured sources
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE (version_id, chunk_index)
);
CREATE INDEX chunks_tenant ON chunks (tenant_id, kb_id);
CREATE INDEX chunks_tsv ON chunks USING GIN (tsv);
CREATE INDEX chunks_vec ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE TABLE trained_answers (          -- curated Q→A that short-circuit retrieval
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL, kb_id UUID NOT NULL,
  query TEXT NOT NULL, answer TEXT NOT NULL,
  embedding VECTOR(1536), is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE tools (
  source_or_kb_id UUID PRIMARY KEY,     -- one row per provisioned tool (source-typed or kb-unified)
  tenant_id UUID NOT NULL,
  assistable_tool_id TEXT, assistant_ids TEXT[] NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL CHECK (kind IN ('structured','semantic')),
  last_error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE sync_runs (
  id UUID PRIMARY KEY, source_id UUID NOT NULL, version_id UUID,
  started_at TIMESTAMPTZ NOT NULL, heartbeat_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  items_count INT, error TEXT, manual BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE query_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL, source_id UUID, kb_id UUID,
  channel TEXT,                         -- inferred from headers: direction/to/from present → voice
  args JSONB NOT NULL, top_score REAL, result_count INT,
  answerable BOOLEAN, relaxations TEXT[], latency_ms INT, cache_hit BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id UUID, actor TEXT, event TEXT NOT NULL, detail JSONB
);
```

**Invariants:** one `active` version per source (partial unique index);
retrieval reads only through `active_version_id`; version flip = one UPDATE in
one transaction; rollback = reverse flip; superseded versions GC'd after 2
newer generations. Deterministic chunk IDs make every pipeline stage re-runnable.

**Versioning is the freshness story:** "the price changed" = new version built
in the background, validated, flipped atomically. Callers never see a
half-updated KB, and a bad feed can be rolled back in one click.

---

## 5. Ingestion & real-time sync

**Connector interface (the extensibility seam — §18):**

```js
// every connector: async fetch(config, ctx) -> one of
// { kind:'documents', docs:[{uri,title,mime,bytes}] }   → parse → chunks
// { kind:'chunks', chunks:[{text,headingPath,metadata}] } → direct
// { kind:'rows', rows:[{...}] }                          → structured
```

**v1 connectors:** `file` (PDF/DOCX/TXT/MD via unstructured-style parsing;
**CSV/XLSX always routed to rows, never raw text**), `url`, `website` (same-
origin BFS crawler, robots.txt, heading-path chunks), `faq`, `text`, `feed`
(JSON/CSV/XML endpoints, nested-array discovery), `csv` upload, `database`
(Postgres/Supabase read-only: SELECT-only template, ident validation,
statement_timeout, row cap), `push` (they call us).

**SSRF defense is mandatory** for `url`/`website`/`feed`: DNS-resolve-then-
verify against private/link-local/metadata ranges, connect-time IP pinning
(undici Agent custom lookup), re-validate every redirect hop, scheme/port
allowlist, size + time caps. Customer-supplied URLs are hostile input in a
multi-tenant product. (Reference implementation: KB Bridge `ssrf-guard`.)

**Type-aware chunking:** prose → heading-boundary splits, 800-1200 chars, 15%
overlap, `heading_path` prepended; FAQ → one chunk per pair; tabular → **one
chunk per row**, `structured` JSONB + a synthesized text line ("2022 Toyota
Tacoma SR5, $28,500, 31k miles, silver") for hybrid matching; column type
inference (numeric / categorical ≤25 distincts / text) persisted as
`column_meta` — this powers filters and tool-schema generation.

**Real-time triggers:**
1. **Push API:** `POST /api/v1/sources/:id/content` (full replace) or
   `POST /api/v1/sources/:id/refresh` (re-pull now). Auth: tenant API key +
   optional HMAC `X-LiveKB-Signature: sha256=…` (constant-time). This is
   "a car sold → gone from answers in under a minute."
2. **Schedules:** the in-process scheduler sweeps every 30s and runs due
   sources (`next_run_at`, ±10% jitter).
3. **Manual:** portal "Sync now" (+ `force` to bypass the shrink gate).

**Change detection:** `content_hash` over normalized content BEFORE any
embedding; unchanged → cheap no-op sync, freshness timestamp bumped. Makes
15-minute schedules affordable.

**Validation gate + atomic swap** (proven in the KB Bridge design): build fully
→ gate (`item_count ≥ 1`; shrink guard: new < 30% of old fails without `force`;
coercion-failure rate ≤ 20%) → single-transaction flip → old version retained
for rollback. A failed sync **never** damages what agents are currently serving.

**Failure ladder:** transient (network/429/5xx) → backoff 1m/5m/15m; permanent
(parse/SSRF/auth) → `error`, no auto-retry; 3 consecutive failures → `stale`
(still serving last good version) + email/webhook to the customer + banner in
portal. Crash recovery: heartbeated `sync_runs`; on boot, running-with-stale-
heartbeat → `failed`.

---

## 6. Indexing pipeline (in-process)

One scheduler loop (30s tick, the MVP engine) drives staged jobs — no external
queue system:

```
stage ingest    (conc 2 across sources)  fetch → normalize → chunk → hash gate
stage embed     (only if vectors enabled) local model, batched, CPU
stage activate                            gate → version flip → cache bust → notify
stage gc        (daily)                   superseded versions, query_log retention (90d)
```

- Embedding cost is CPU time, not money: local model, hash-cache keyed
  `sha256(text)` in a SQLite table (re-syncs of mostly-unchanged content
  re-embed almost nothing). Big ingests are throttled (chunk batches of 64,
  yield between batches) so the hot path never starves — Node is
  single-threaded; run the embedder in a `worker_threads` pool sized
  `cores - 1` to keep webhook latency flat during syncs.
- Idempotency: deterministic chunk IDs + upsert; deterministic run keys
  `kb-ingest-{sourceId}-{versionNum}`.
- Every stage writes progress to `sync_runs` (heartbeats, crash recovery on
  boot); the portal shows a live pipeline view per sync.

---

## 7. Retrieval engine

Two engines, one webhook, dispatched by source/tool kind.

### 7.1 Structured (feeds, CSV, DB, tabular files) — the accuracy headline

- Typed filters from tool args (`price_max`, `year_min`, categorical equality)
  → JSONB predicates with **bound** paths (column names are tenant data — never
  interpolated into SQL).
- Categorical resolution: exact → case-insensitive → alias table (seeded:
  chevy→chevrolet, vw→volkswagen…; tenant-extendable) → edit-distance ≤ 2.
- Tiered relaxation on zero hits: widen numerics ±15% → drop least-selective
  filter → lexical fallback — always returning `close_alternatives` labeled as
  such with what differs. **Never a bare empty result**: "no 2022 Tacoma under
  $30k, but a 2021 at $26,900" is the money answer on a live call.

### 7.2 Hybrid semantic (docs, websites, FAQs) — BM25-first, vectors optional

1. Normalize query (no LLM rewriting on the hot path — latency AND cost).
2. **Primary leg (always, $0): FTS5 BM25** — sanitized `"token"* OR …` match,
   `bm25()` ranking with column weights (title/heading 2×), topK 20,
   tenant+kb scoped.
3. **Optional second leg (still $0, per-KB flag): local vectors** —
   `all-MiniLM-L6-v2` query embed (in-process, 20-60ms) → `sqlite-vec` cosine
   topK 20. Enable when a KB's BM25 answerable-rate disappoints (§15 tells you).
4. When both legs ran: Reciprocal Rank Fusion (`Σ 1/(60+rank)`), dedupe, top 12;
   then keyword-overlap rerank (weight 0.3). No LLM reranker.
5. **Confidence floor** → below it, `answerable:false`, zero chunks. BM25
   scores are normalized per-query (`score/max_score`) with floor 0.35; vector
   cosine floors at 0.4. The single biggest anti-hallucination lever; the
   static KB has no floor at all (verified) — we make "I don't know" a
   first-class, correct answer.
6. **Trained answers:** matched by normalized-text equality + BM25-over-trained-
   queries (vector match ≥ 0.85 when vectors enabled) — short-circuits
   retrieval (`citation.kind='trained'`); CS's direct lever when an agent must
   answer something exactly.

BM25 is not a consolation prize here: KB content is domain-narrow (one
business's docs), where keyword search with stemming + prefix matching performs
near parity with embeddings — and it's what the zero-cost Support Copilot
already validated on real support tickets.

### 7.3 Response contract (what the agent receives — both channels)

```jsonc
{
  "ok": true, "answerable": true,
  "result_count": 2, "as_of": "2026-07-13T09:00:00Z", "data_freshness": "fresh",
  "applied_filters": {"model": "Tacoma", "price_max": 30000},
  "relaxations": [],
  "items": [{"title": "2022 Toyota Tacoma", "price": 28500, "mileage": 31000, "color": "Silver", "vin": "VIN001",
             "citation": {"source": "Riverside Inventory", "as_of": "2026-07-13T09:00:00Z"}}],
  "close_alternatives": [],
  "speech_hint": "Yes - we have a 2022 Tacoma in silver at $28,500 with 31,000 miles.",
  "guidance": "Only state what this tool returns. If answerable is false, say you don't have that information."
}
```

Semantic results carry `citation: {source, title, heading_path, url?, version, as_of}`
and confidence band (`high ≥0.72 / medium ≥0.55 / low ≥0.4`, recalibrated from
evals — §15). Whole body ≤ ~1200 chars on voice (items dropped from 5 down to
fit); citations inline in chunk text too (`"…text… [Pricing FAQ, updated Jul 13]"`)
so provenance survives models that ignore JSON structure.

---

## 8. Tool provisioning (how agents get connected)

Two tool kinds, both created via the customer's key from the portal:

1. **Typed structured tool per structured source** — `search_<slug>` with
   generated flat params: `query` + up to 6 filters (categorical enums in
   descriptions, `_min`/`_max` numeric pairs, `""`/`0` sentinels — required-
   forcing-safe, §1.5). Best accuracy for inventory/catalog.
2. **Unified semantic tool per KB** — `knowledge_<slug>` with just `query`.
   Stable forever → no voice re-save churn.

Provisioning flow (portal): pick assistants (from `GET /v3/assistants`) →
create tool (409 → suffix retry) → assign each → store ids. Schema drift on a
structured source updates only the tool **description** (chat picks it up
immediately; voice needs assistant re-save → banner in portal: "Re-save your
assistant in Assistable to refresh voice"). PATCH sends complete headers+params
(partial merge impossible — verified).

**Static-KB coexistence (important operational reality):** if the assistant
still has a static KB linked, voice gets Assistable's own `knowledge_base` tool
with an "only source of truth" description (`telnyx-tool-translator.ts:632-662`)
competing with ours. Onboarding guidance (enforced by a portal checklist):
- For domains the Live KB owns (inventory, catalog, anything that changes):
  unlink the static KB or remove those docs from it.
- Our tool descriptions name the domain explicitly ("ALWAYS call before
  answering any question about vehicle inventory…").
- We give the customer a one-paragraph prompt snippet to paste into the
  assistant instructions (§12) — copy button in the portal.

---

## 9. Multi-tenancy & permissions

- Every query and every row is scoped by `tenant_id` — denormalized onto
  `chunks` so no join can widen scope. SQLite has no RLS, so isolation is
  structural in the data-access layer: routes can only reach data through
  `owned*()` functions that take the authenticated tenant id (the KB Bridge
  `tenant.js` pattern), enforced by the release-gate test suite below.
  (If the Postgres migration ever fires, RLS gets added as defense-in-depth.)
- Webhook auth: per-source 32-byte secret in the tool header, constant-time
  compare, 404 on failure (not retried by the proxy — verified). Optionally
  cross-check the `location_id` header against the tenant's connected
  subaccount (defense-in-depth; header can be absent — never require it).
- Portal auth: bcrypt(12), hashed session tokens, SameSite cookies, custom-
  header CSRF, login rate limits + lockout; org/teammates in v2.
- Tenant API keys (for push + management API): `lkb_live_…`, hashed at rest,
  scoped (`ingest`, `manage`, `read`), revocable, shown once.
- Tags on sources → query-time filtering; per-source ACLs later (§18).
- **Tenant-isolation test suite is a release gate**: two-tenant fixtures assert
  no endpoint — search, portal, analytics, logs — ever crosses tenants.
- Noisy neighbors: per-source hot-path rate limit (60/min default, soft-fail
  JSON, never 429 — §1.3); per-tenant ingest concurrency 2; per-tenant embed
  budget.

---

## 10. Low-latency engineering (voice-first)

Caller tolerance is ~1s of silence, and there IS silence — `speakDuringExecution`
is dead on the Telnyx path (verified). Budget:

| Stage | p95 |
|---|---|
| Edge + TLS (Caddy on the VM) | 20ms |
| Auth (secret compare) + tenant resolve | 2ms |
| Local query embed (ONLY if vectors enabled) | 20-60ms — 0ms BM25-only or cache hit |
| SQLite (FTS5 ‖ sqlite-vec, or JSON filters) | 5-30ms |
| Fusion + response build | 5ms |
| **Total** | **≈ 30-120ms** (BM25/structured path ~30-60ms) |

Tactics: in-process LRU query-result cache (60s TTL, key
`sha256(tenant|source|normalized_args)`, busted on version flip — voice callers
ask the same 20 questions all day, expect >50% hits); embedding hash-cache;
prepared-statement cache (better-sqlite3 makes this trivial); structured path
never embeds at all; embedder in worker threads so syncs can't spike webhook
latency; degraded ladder under the 2.5s deadline: hybrid → BM25-only (skip
embedding) → cached-any → `answerable:false, degraded:true`. **Always HTTP
200** — a spoken "let me check another way" beats the proxy's 15s×4 retry storm
(§1.3) every time. Note the zero-cost design is *faster* than the paid one it
replaced: no network hop can be slower than no network hop.

---

## 11. API design

### 11.1 Hot path (called by Assistable's proxy)
`POST /api/tools/:sourceOrKbId/search` — the contract in §1 + §7.3. Auth:
`x-bridge-secret`. Envelope-parsed (`body.args` when `meta_data|metadata|call`
present, else body). Channel inferred from headers (`to`/`from` present → voice)
for analytics only — behavior is identical.

### 11.2 Management API (tenant API key)
```
POST /api/v1/kbs · GET /api/v1/kbs
POST /api/v1/kbs/:id/sources            create source (connector+config)
POST /api/v1/sources/:id/refresh        re-pull now
POST /api/v1/sources/:id/content        push replace (HMAC optional)  ← real-time path
GET  /api/v1/sources/:id/versions       list versions
POST /api/v1/sources/:id/rollback       flip to previous version
POST /api/v1/sources/:id/query          direct search (same engine, for testing/other consumers)
GET  /api/v1/sources/:id/analytics      volume, answerable rate, unanswered top-N
POST /api/v1/tools/provision            create+assign tools for chosen assistants
```
JSON envelope `{data, error, request_id}`; per-key rate limits; OpenAPI spec
published; webhook events out (`sync.completed`, `sync.failed`, `source.stale`)
with HMAC signatures.

### 11.3 Versioned + boring
API is `/v1`; breaking changes = new version; the hot-path contract (§7.3) is
append-only forever — agents in production depend on its shape.

---

## 12. Context optimization & anti-hallucination

1. Confidence floor + `answerable:false` (§7.2.5) — nothing weak ever reaches
   the model.
2. `guidance` field in every response instructs the model ("only state what
   this tool returns…") — reinforced by the platform's own no-fabrication
   guard appended to webhook tools (verified, `telnyx-tool-translator.ts:585-591`).
3. **Prompt snippet** (portal copy-button, part of onboarding):
   > "For ANY question about {domains}, ALWAYS call {tool names} first and
   > answer only from the result. If the tool says answerable is false or
   > returns nothing, say you don't have that information and offer to take a
   > message. When a speech_hint is present, read it aloud. If data_freshness
   > is 'stale', say the info is as of the last update."
4. `speech_hint` pre-composes the voice answer (deterministic template) so the
   voice model reads instead of reasons.
5. Compact context: ≤5 items, ≤1200 chars, salient fields only; citations
   inline.
6. Freshness honesty: `data_freshness: stale` when last sync > 2× schedule —
   the agent hedges honestly instead of asserting stale facts.
7. Trained answers for must-be-exact questions (pricing policy, compliance).

---

## 13. Caching & scalability

- **Honest capacity on the free tier:** an Oracle A1 VM (4 OCPU/24GB) running
  SQLite in WAL serves read-heavy workloads in the thousands of qps; our hot
  path is 1-3 indexed reads. 200 tool calls/s is comfortably inside that.
  Storage: 5M chunks ≈ 15-40GB on disk (A1 gives 200GB block storage free) —
  the free tier is NOT the bottleneck for any realistic first year of this
  product. The bottleneck is the single box (§14).
- Cache layers (all in-process): query results (60s), embedding hashes,
  tenant/source auth rows (60s), assistant lists (5min, portal only).
- Backpressure: ingest stages bounded + throttled (§6); management API 429s
  with Retry-After (hot path never does — §1.3).
- Growth path, strictly revenue-gated (§17): second VM + hot-standby replica →
  managed Postgres migration through the retained `db.js` seam. Neither before
  paying customers exist.

---

## 14. Reliability: failover, retries, backups, DR

- **Backups ($0):** hourly SQLite `VACUUM INTO` snapshot on local disk
  (keep 24) + nightly copy off-box via `rclone` to a free-tier bucket
  (R2 10GB free) or a second free VM — RPO ≤ 60min offsite, ≤ 60s local
  (WAL survives process crashes; snapshots cover disk loss). Original uploaded
  files backed up the same way → full re-ingest always possible. Restore =
  stop, copy file back, start; runbook tested quarterly; RTO ≤ 30min.
- **Failure behavior:**
  | Failure | Hot-path behavior |
  |---|---|
  | Embedder thread crash | BM25-only automatically (`degraded:false` — it's a normal mode); structured unaffected |
  | Sync/connector failures | Retry ladder → `stale`, last good version keeps serving (§5) |
  | Process crash | systemd restarts in seconds; WAL means no data loss; scheduler recovers stuck runs on boot |
  | VM down | UptimeRobot alert; agents get tool-transport errors ("brief connection issue" — the platform's own wording, verified `tool-proxy.service.ts:550-556`) until restart |
  | Disk full | Monitored (alert at 80%); log rotation + backup retention caps |
- **The single-box truth, stated honestly:** at $0 there is one VM; its uptime
  is the product's uptime. Mitigations that stay free: systemd auto-restart,
  WAL durability, offsite backups, a pre-provisioned cold-standby free VM in a
  second region (restore latest snapshot + flip DNS — documented drill,
  ~15-30min). True hot failover is the FIRST paid upgrade (§17), and the
  200-always contract means even hard downtime degrades to agents apologizing
  gracefully rather than calls hanging.
- Retries: everything transient retried with jittered backoff at the sync
  layer; the hot path NEVER retries outward — with local embeddings it has no
  outbound calls at all.
- Deploys: `git pull && npm ci && systemctl restart` behind Caddy (sub-second
  downtime window, off-peak), health-checked; schema migrations
  expand-then-contract (never break the running version).

---

## 15. Monitoring, analytics, retrieval quality

- **Logs:** structured JSON, request-id + trace through pipeline stages;
  secrets redacted by key-pattern; errors → GlitchTip.
- **Metrics + alerts:** webhook p50/95/99 by kind; cache hit rates; sync
  success/freshness lag per source; queue depth; embed spend/day/tenant;
  alert on p95 > 500ms (5min), sync-failure spike, queue > 5k, freshness
  lag > 2× schedule on any source with traffic.
- **Per-tenant analytics (portal — this is also the product's proof of value):**
  query volume by day/channel, answerable rate, top queries, **unanswered
  queries** (0-result / below-floor) with one-click fixes: promote to trained
  answer, add alias, or "add this to your data" hint. This is the accuracy
  flywheel and the retention feature.
- **Quality program:** golden question→source sets per vertical (dealership,
  ecommerce, services) run nightly in CI against seeded tenants — recall@5 +
  MRR regression fails the build; monthly sampled relevance labeling
  recalibrates the confidence bands.

---

## 16. Security summary

Threats: cross-tenant leakage, SSRF via customer URLs, credential theft
(Assistable keys, DB creds), webhook forgery, injection via tenant data.

Controls (all specified above, gathered): tenant scoping + RLS + release-gate
isolation tests (§9) · SSRF guard with IP pinning (§5) · AES-256-GCM envelopes
for Assistable keys + connector creds, key-id rotation, write-only UI (§4) ·
per-source secrets, constant-time compare, 404-on-fail (§9) · HMAC on push +
outbound webhooks (§5, §11) · bound JSON paths, sanitized FTS5 match
expressions, ident validation (§7) · bcrypt/hashed sessions/CSRF/rate limits (§9) · TLS everywhere,
helmet/CSP on portal · append-only `audit_log` (auth events, key changes,
source/tool CRUD, rollbacks, admin actions) surfaced per-tenant · logger
redaction · tenant offboarding purge job · dependency audit in CI.

Known platform caveat we document to customers: tool headers (our per-source
secret) are readable in their own Assistable account by any key with
`tools:READ` (verified) — the secret only grants search on that one source and
is rotatable in one click from the portal (rotation updates the tool header via
PATCH; URL/header changes apply to voice immediately — verified §1.5).

---

## 17. Delivery plan: MVP → production

**Phase 0 — the KB Bridge MVP (already fully planned):** the 15-task TDD plan
(`docs/superpowers/plans/2026-07-13-dynamic-kb-portal.md`) IS phase 0 —
Express + SQLite, structured search + BM25 text search, tool provisioning, the
verified contract. Already 100% zero-cost. Build it, onboard 2-3 design
partners (a dealership, an ecommerce store), validate on real calls via the
free Render URL + pinger.

**Phase 1 — free-infra production hardening (weeks 3-5):** move to the Oracle
Always Free VM: Caddy auto-TLS + domain/DuckDNS, systemd unit with auto-restart,
hourly `VACUUM INTO` + offsite rclone backups, logrotate, UptimeRobot, disk
alerts, the cold-standby drill (§14). Versioned sources + validation gates +
rollback (upgrade from the MVP's batch model to `source_versions`). Free Sentry
tier wiring.

**Phase 2 — semantic KB, still $0 (weeks 5-8):** website/docs/FAQ onboarding
polished; BM25 engine with normalized floor + citations + trained answers;
`knowledge_<slug>` unified tools; **local embeddings + sqlite-vec behind a
per-KB flag** (worker-thread pool); golden-set evals in CI.

**Phase 3 — real-time + product (weeks 8-11):** push API + HMAC, outbound
webhook events, per-tenant analytics + unanswered-queries flywheel, onboarding
checklist incl. static-KB coexistence, OpenAPI docs, public status page (free
UptimeRobot page).

**Revenue-gated spend triggers (the ONLY places money ever enters, in order):**
| Trigger | First spend |
|---|---|
| First paying customer | Proper domain (~$10/yr) |
| ~10 paying customers / uptime complaints | Second VM hot standby, or Render Starter always-on (~$7/mo) |
| >100 sustained qps or >50GB data | Managed Postgres migration through the `db.js` seam |
| Enterprise/security asks | Paid Sentry/SSO/etc. |

**Testing throughout:** unit + integration per module (the MVP plan's TDD
style), tenant-isolation gate, load test at 3× target (k6), chaos drills
(kill the embedder thread / fail a connector / kill the process mid-sync —
assert §14 behavior),
one real-voice-call E2E per release ("2022 Tacoma under $30k" against a
staging tenant, answer < 1s, correct price).

**CI/CD:** GitHub Actions — lint, unit/integration, golden-set evals, migration
dry-run, deploy on main to staging → manual promote to prod (Render), instant
rollback = previous deploy + version-flip rollback for data.

---

## 18. Future extensibility

- **Connector SDK:** the `fetch(config, ctx)` interface + zod config schema +
  fixture harness; new connectors (Google Drive, Notion, Zendesk, Shopify,
  GHL custom objects) are additive modules; registry-driven portal UI.
- **Push adapters:** Shopify/GHL/DMS webhook translators (~100 lines each) onto
  the push seam.
- **Per-source ACLs / teammate roles** on existing tags + tenants tables.
- **LLM reranker, HyDE, multilingual FTS + embeddings** — flags on the semantic
  engine, chat-only budgets.
- **Beyond Assistable:** the hot path is a clean tool/function-calling API —
  the same product serves Vapi/Retell/OpenAI-tools customers later with only a
  new provisioning adapter per platform (the retrieval engine is
  platform-agnostic by construction).

## 19. Plans & cost guardrails (operational, not billing advice)

The product itself runs at $0, so launch pricing is free — the guardrails exist
to protect the shared box, not a bill: per-tenant sync-frequency floor (15min),
ingest concurrency 2, hot-path soft limit 60/min/source, embed-CPU budget/day,
max source sizes (20k rows / 50 pages / 20MB feed). `query_log` is already the
metering source if paid tiers ever exist (hourly sync, push API, vector search,
higher limits are the natural paid levers). No Stripe until there's something
to charge for.

---

## Appendix — Decision log

| Decision | Why |
|---|---|
| Standalone product; tools are the ONLY integration | We can't code Assistable's backend; the tool surface is public, verified, and works on both channels automatically |
| $0 everything: SQLite + FTS5 + local embeddings + Oracle Always Free | Hard cost constraint; and the no-external-calls hot path is simultaneously the fastest design (~30-120ms vs 250-400ms with API embeddings) |
| BM25-first, local vectors optional per-KB | Domain-narrow KBs make keyword+stemming near-par with embeddings (validated by the zero-cost Support Copilot); vectors stay available at $0 via fastembed + sqlite-vec |
| Version-flip freshness | Atomic, rollbackable, idempotent — proven pattern; "live" must never mean "half-updated" |
| Structured rows first-class | Verified static-KB failure: CSV-as-text; filters beat cosine for facts |
| 200-always, 2.5s deadline | Verified proxy retry amplification (15s×4) vs Telnyx 10s + silent caller |
| Flat forced-required-safe tool schemas, stable | Verified: all top-level params forced required; voice bakes schema at assistant-save |
| Confidence floor + answerable:false | The anti-hallucination lever the static KB lacks entirely |
| Single-box risk accepted, drilled, and revenue-gated | Honest tradeoff of $0; cold-standby drill + WAL + offsite snapshots bound the damage; first dollars buy the second box |
