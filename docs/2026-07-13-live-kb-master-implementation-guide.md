# Assistable Live KB — Master Implementation Guide

**Status:** v1.0 — 2026-07-13
**Audience:** engineers building the Live KB into the Assistable platform (`assistable-buildship-replacement-be` + `assistable-v2`), plus Hari as product owner.
**Scope:** replace the static KB as the primary source of truth for AI agents — real-time, multi-tenant, voice-grade latency, thousands of customers.

Every claim about current behavior below is verified against the platform source
(`Case Study/_assistable-code`); citations are `repo path:line`. This guide is
implementation-focused: it says what to build, where it lives, the schemas, the
budgets, and the rollout order.

---

## 0. Executive summary

Assistable's KB today is **frozen-at-upload vector search**: sources are chunked
and embedded once, retrieval is a raw cosine top-K with no score floor, and there
is no update path — refresh means delete + re-upload, and until the old source is
deleted, stale and fresh chunks answer side by side. Structured data (inventory,
catalogs, price lists) is chunked as blind text, so numeric questions fail.

The Live KB replaces this with a **versioned, event-driven knowledge platform**:

1. **Sources are versioned, not frozen.** Every re-ingest creates a new version;
   an atomic pointer swap makes it live; the previous version is retained for
   instant rollback. Refresh is a first-class, automatic operation.
2. **Retrieval is hybrid**: pgvector semantic + Postgres full-text (BM25-like)
   fused with Reciprocal Rank Fusion, plus **structured filter search** for
   tabular sources — so "2022 Tacoma under $30k" is a SQL predicate, not a
   cosine guess.
3. **Answers carry citations and calibrated confidence**, with an explicit
   "not answerable" outcome so agents say "I don't know" instead of hallucinating.
4. **Voice-grade latency** is engineered end to end: the Telnyx webhook budget is
   10s hard; we target p95 ≤ 400ms for the full retrieval round trip.
5. **Multi-tenant by construction**: every row and every query is scoped by
   `subAccountId`; retrieval cannot cross tenants.

Crucially, this is **not a greenfield system**. It is built on the stack the
platform already runs (Fastify BE on EC2/Traefik, BullMQ + Redis, Neon Postgres
with pgvector already in the schema, QStash/Vercel on the v2 side), and about
half of the retrieval engine already exists in v2's KB playground — it was simply
never promoted to the production path. The plan below promotes, hardens, and
extends what exists rather than inventing parallel machinery.

---

## 1. Current state (verified baseline) and why it must change

| Area | Today (verified) | Consequence |
|---|---|---|
| Chat retrieval | Embed raw last message (`text-embedding-3-small`) → Pinecone topK 3 per namespace, no score floor, no rerank; chunks appended to prompt (`be/packages/api/src/services/agent-run.ts:957-999`) | Irrelevant chunks injected when KB has nothing better; follow-ups embed without context |
| Voice retrieval | One `knowledge_base` GET webhook per agent → `/knowledge-base/retrieval/:id`, topK 6, `{recommendations: string[]}`, $0.01/query billed via Redis (`be/.../routes/knowledge-base.ts:64-144`) | Only ONE KB per voice agent (newest linked wins, `telnyx-agent.ts:92-99`); no floor; raw chunks |
| Hybrid pipeline | Exists — query contextualization, pg FTS, rerank, 0.4 floor — but **playground-only** (`v2/.../rag-chat.service.ts:66-117,1026`) | Production never benefits |
| Chunking | 1000 chars / 200 overlap, paragraph splitter; **CSV parsed as raw text** (`v2/.../chunking.service.ts:17`, `unstructured.service.ts:106`) | Tabular rows severed mid-record; numeric filters impossible |
| Freshness | Vectors written once; deleted only on explicit source delete; non-deterministic vector IDs mean re-processing duplicates (`v2/.../knowledge-processor.service.ts:62,104,347`) | No refresh path; stale+fresh compete on cosine score |
| v3 API ingestion | Sources created `PENDING`; **nothing processes them** — no cron, no worker (`be/.../routes/v3/knowledge.ts:282-284`) | The public API silently produces dead sources |
| Query Training | Stored + embedded but consulted only in the playground (`v2/.../rag-chat.service.ts:725`) | Dead product feature |
| Multi-KB voice | `voiceEnabled` not checked at retrieval (`be/.../routes/v3/knowledge.ts:41-56` vs retrieval route) | Confusing product behavior |

These are not style complaints; each maps to a customer-visible failure mode
(wrong price quoted, stale inventory offered, API integrations that never work).

---

## 2. Goals, non-goals, SLOs

**Goals**
- G1. Freshness: a source change is queryable within **60s** (push/webhook) or
  one schedule tick (pull), with per-answer `as_of` visibility.
- G2. Accuracy: structured questions answered by structured search; unstructured
  by hybrid retrieval with a confidence floor and citations.
- G3. Latency: retrieval API p95 ≤ **300ms** server-side (chat), ≤ **400ms** for
  the voice webhook round trip; hard internal deadline 2.5s with a degraded-but-
  valid response (never a timeout the proxy retries — see §11).
- G4. Scale: 5,000 tenants, 5M chunks, 200 retrievals/s sustained without
  architecture change.
- G5. Tenancy: zero cross-tenant reads, provable by test.
- G6. Operability: every retrieval traceable (query → candidates → answer), and
  retrieval quality measurable week over week.

**Non-goals (v1)**
- Cross-tenant/global knowledge sharing; marketplace content.
- Fine-tuning or per-tenant embedding models.
- Replacing Pinecone on day one (dual-read migration, §17).
- Real-time collaborative editing of KB documents.

**SLOs**
| Metric | Target |
|---|---|
| Retrieval availability | 99.9% monthly |
| Retrieval p95 (server) | ≤ 300ms |
| Ingest freshness (push) | ≤ 60s p95 |
| Failed-sync detection | ≤ 1 tick (30s) + alert |
| RPO / RTO | ≤ 5 min / ≤ 30 min (§14) |

---

## 3. System architecture

```
                        ┌────────────────────────────────────────────┐
                        │              Assistable v2 (Vercel)        │
                        │  KB UI: sources, versions, tags, analytics │
                        └───────────────┬────────────────────────────┘
                                        │ tRPC / v3 API
┌───────────────┐   webhooks/push   ┌───▼─────────────────────────────────┐
│ Customer data │ ────────────────► │        Live KB service (BE repo)    │
│ docs/sites/   │   pull (sched.)   │  Fastify routes  ·  BullMQ workers  │
│ feeds/DBs     │ ◄──────────────── │  ┌──────────┐  ┌─────────────────┐  │
└───────────────┘                   │  │ Ingestion │  │ Retrieval engine│  │
                                    │  │ pipeline  │  │ hybrid+struct.  │  │
                                    │  └─────┬────┘  └────────┬────────┘  │
                                    └────────┼────────────────┼───────────┘
                                             │                │
                              ┌──────────────▼──┐   ┌─────────▼──────────┐
                              │ Neon Postgres   │   │ Upstash Redis      │
                              │ pgvector + FTS  │   │ cache · queues ·   │
                              │ (system of      │   │ rate limits        │
                              │  record)        │   └────────────────────┘
                              └─────────────────┘
                                             ▲
              ┌──────────────────────────────┴───────────────────────────┐
              │ Consumers: chat agent-run · Telnyx voice webhook ·       │
              │ chat widget · v3 public API · (KB Bridge live-data tools)│
              └──────────────────────────────────────────────────────────┘
```

**Placement decisions**

- **The Live KB lives in the BE repo** (`assistable-buildship-replacement-be`) as
  a module: `packages/api/src/services/kb/` + `routes/v3/kb.ts` + BullMQ workers.
  Reasons: retrieval consumers (agent-run, telnyx webhook, chat widget) are
  already there; BullMQ/Redis is already there; it deploys as N replicas behind
  Traefik with a 1000 req/s design target (BE CLAUDE.md). v2 keeps the UI and
  its upload flows but delegates processing to the same pipeline.
- **Postgres (Neon) is the system of record** for documents, versions, chunks,
  embeddings (pgvector — the `knowledgeChunk.embedding` column already exists),
  and FTS. Pinecone remains a secondary index during migration only (§17).
  One store = one consistency story = simpler DR.
- **Schema-parity rule applies**: every new model added for Live KB MUST be
  mirrored verbatim in both repos' Prisma schemas with `/// Owned by` directives
  (both CLAUDE.mds; the parity CI blocks drift). Never `db push --accept-data-loss`.
- **Structured live-data sources** (inventory/catalog feeds, customer DBs) use
  the tool-based structured search engine designed and validated in the KB Bridge
  project (`assistable-dynamic-kb` spec + plan). In-platform, that engine becomes
  source type `STRUCTURED` with the same atomic-batch, filter-search, and
  relaxation semantics — served from the same retrieval API.

---

## 4. Data model

New tables (Prisma models mirrored in both repos; DDL shown for clarity).
Existing `KnowledgeBase` / `KnowledgeSource` stay; new tables attach to them.

```sql
-- One row per ingest run that produced content. Versioning backbone.
CREATE TABLE kb_source_version (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES "knowledgeSource"("_id") ON DELETE CASCADE,
  version_num   INTEGER NOT NULL,               -- monotonic per source
  content_hash  TEXT NOT NULL,                  -- sha256 of normalized content
  status        TEXT NOT NULL DEFAULT 'building' -- building|active|superseded|failed|rolled_back
    CHECK (status IN ('building','active','superseded','failed','rolled_back')),
  item_count    INTEGER,
  column_meta   JSONB,                          -- structured sources: inferred columns
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  UNIQUE (source_id, version_num)
);

-- Chunks belong to a VERSION, not directly to a source.
CREATE TABLE kb_chunk (
  id            TEXT PRIMARY KEY,               -- DETERMINISTIC: {versionId}_{idx}
  version_id    TEXT NOT NULL REFERENCES kb_source_version(id) ON DELETE CASCADE,
  sub_account_id TEXT NOT NULL,                 -- denormalized for tenant-scoped queries
  kb_id         TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  heading_path  TEXT,                           -- "Service Dept > Pricing"
  embedding     VECTOR(1536),
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  structured    JSONB,                          -- row payload for STRUCTURED sources
  metadata      JSONB NOT NULL DEFAULT '{}',    -- source_url, page_title, filename…
  UNIQUE (version_id, chunk_index)
);
CREATE INDEX kb_chunk_tenant ON kb_chunk (sub_account_id, kb_id);
CREATE INDEX kb_chunk_tsv    ON kb_chunk USING GIN (tsv);
CREATE INDEX kb_chunk_vec    ON kb_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Tags/categories: tenant-defined, attach to sources; filterable at query time.
CREATE TABLE kb_tag (
  id TEXT PRIMARY KEY, sub_account_id TEXT NOT NULL,
  name TEXT NOT NULL, UNIQUE (sub_account_id, name)
);
CREATE TABLE kb_source_tag (
  source_id TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES kb_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
);

-- Sync scheduling + connector config (encrypted), per source.
CREATE TABLE kb_sync_config (
  source_id     TEXT PRIMARY KEY,
  connector     TEXT NOT NULL,     -- 'url','file','faq','text','website','feed','database','push'
  config_ct     TEXT NOT NULL,     -- AES-256-GCM envelope (creds live here, never plaintext)
  schedule_min  INTEGER,           -- null = push/manual only
  next_run_at   TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  webhook_secret TEXT              -- for push-source HMAC validation
);

-- Every retrieval, for observability + quality metrics (§16). 30-day retention.
CREATE TABLE kb_query_log (
  id BIGSERIAL PRIMARY KEY,
  sub_account_id TEXT NOT NULL, kb_ids TEXT[] NOT NULL,
  assistant_id TEXT, channel TEXT,               -- chat|voice|widget|api
  query TEXT NOT NULL, filters JSONB,
  top_score REAL, result_count INTEGER, answerable BOOLEAN,
  latency_ms INTEGER, cache_hit BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kb_query_log_tenant ON kb_query_log (sub_account_id, created_at DESC);
```

**Versioning invariants**
- Exactly one `active` version per source (partial unique index on
  `(source_id) WHERE status='active'`).
- Retrieval joins through active versions only; a version flip is one UPDATE in
  one transaction → refresh is atomic and rollback is `UPDATE … SET status`.
- Chunk IDs are deterministic (`{versionId}_{idx}`) — re-processing a version is
  idempotent, fixing today's duplicate-vector bug
  (`knowledge-processor.service.ts:62`).
- Superseded versions are GC'd after N=2 newer active generations (keep one for
  rollback), by a daily worker.

**Permissions model (v1, deliberately simple)**
- KB ↔ assistant assignment (exists today) controls which agents can retrieve.
- API keys use existing v3 scopes (`knowledge:*`,
  `be/.../middleware/require-scope.ts`).
- Tags enable query-time filtering (`filters.tags`), not ACLs.
- v2 (future): per-source visibility rules (e.g., internal-only sources excluded
  from customer-facing agents) — the `kb_source_tag` join is the hook.

---

## 5. Ingestion & connectors

One pipeline, many connectors. Every connector implements the same interface
(this is the extensibility seam — §19):

```ts
interface Connector {
  name: string;                                   // 'website', 'feed', …
  // Pull current content. Must be side-effect free and cancellable.
  fetch(config: ConnectorConfig, ctx: FetchCtx): Promise<FetchResult>;
}
type FetchResult =
  | { kind: "documents"; docs: Array<{ uri: string; title: string; mime: string; bytes: Buffer }> }
  | { kind: "chunks"; chunks: Array<{ text: string; headingPath?: string; metadata?: object }> }
  | { kind: "rows"; rows: Array<Record<string, unknown>> };   // structured
```

**v1 connectors**

| Connector | Input | Notes |
|---|---|---|
| `file` | PDF/DOCX/XLSX/TXT/MD upload | Existing Unstructured-API parse path (`v2/.../unstructured.service.ts`) retained; **CSV/XLSX routed to `rows`, never raw text** (fixes the tabular-chunking failure) |
| `url` | Single page | Existing Firecrawl scrape (`v2/.../firecrawl.service.ts`) |
| `website` | Site crawl | Same-origin BFS, robots.txt, page/depth caps, heading-path chunking — lift the KB Bridge crawler design |
| `faq` | Q&A pairs | Existing; one chunk per pair (already structure-aware) |
| `text` | Raw text | Existing |
| `feed` | JSON/CSV/XML endpoint | → `rows`; KB Bridge feed connector design (nested-array discovery, flattening) |
| `database` | Postgres/Supabase read-only | → `rows`; SELECT-only templated query, ident validation, statement_timeout, row cap (KB Bridge design) |
| `push` | Customer POSTs content to us | The real-time path — §5.1 |

**SSRF discipline (mandatory for `url`/`website`/`feed`):** DNS-resolve-then-
verify against private/link-local/metadata ranges, re-validate every redirect
hop, connect-time IP pinning, response size/time caps. The KB Bridge
`ssrf-guard` module is the reference implementation; port it into
`packages/api/src/lib/`. Customer-supplied URLs are hostile input in a
multi-tenant system.

**Normalization:** documents → markdown-ish text with heading structure
preserved; rows → typed values via numeric-like parsing (`"$24,995"` → 24995)
and per-column type inference (numeric / categorical ≤25 distincts / text),
stored as `column_meta` on the version. This powers structured search (§7) and
tool-schema generation for live-data tools.

**Chunking (type-aware — replaces one-size-fits-all 1000/200):**

| Content | Strategy |
|---|---|
| Prose docs / pages | Split on heading boundaries, target 800-1200 chars, 15% overlap, prepend `heading_path` to text |
| FAQ | One chunk per Q&A (as today) |
| Tabular | **No chunking.** One `kb_chunk` per row with `structured` JSONB + a synthesized text line ("2022 Toyota Tacoma SR5, $28,500, 31k miles, silver") for hybrid matching |
| Slides/sheets | Per-slide / per-sheet-region via Unstructured elements |

### 5.1 Real-time synchronization

Three triggers, one pipeline:

1. **Push API (≤60s freshness):** `POST /v3/kb/:kbId/sources/:sourceId/content`
   with the new content (or `POST …/refresh` to make us re-pull now).
   Authenticated by API key + optional per-source HMAC (`webhook_secret`,
   `X-KB-Signature: sha256=…` over raw body, constant-time compare). This is
   what "inventory system calls us when a car sells" looks like.
2. **Schedules (pull):** `kb_sync_config.next_run_at`; BullMQ repeatable sweep
   every 30s enqueues due sources. Per-source jitter ±10% to avoid thundering
   herds at midnight.
3. **Manual:** UI "Sync now" and v3 `…/refresh`.

**Change detection:** compute `content_hash` over normalized content BEFORE
embedding. If it equals the active version's hash → record a no-op sync (cheap,
no embedding spend), bump freshness timestamp. This makes aggressive schedules
affordable.

**Atomic swap with validation gate** (lifted from KB Bridge, proven pattern):
build the new version fully (`status='building'`), then gate before activation:
- `item_count ≥ 1`;
- shrink guard: if previous active count > 0 and new < 30% of it → **fail the
  sync, keep serving the old version**, surface "suspicious shrink — use force
  to override" in UI/API;
- type-coercion failure rate ≤ 20% for structured sources.
Activation = one transaction: old `active` → `superseded`, new → `active`.
Rollback is the reverse flip, exposed in UI and API.

**Fixing the v3 PENDING bug is part of this milestone:** the v3 source-create
routes (`be/.../routes/v3/knowledge.ts:281-379`) enqueue the ingestion job
directly (same BullMQ queue) instead of writing dead `PENDING` rows. The v2
UI paths switch from QStash-triggered one-shot workflows to the same queue so
there is exactly one pipeline. (BullMQ jobId rule applies: `kb-ingest-{sourceId}-{versionNum}` —
dashes, never colons; see BE CLAUDE.md incident list.)

---

## 6. Indexing pipeline (workers)

BullMQ queues (all in BE, Redis-backed, following existing worker conventions):

```
kb-ingest    concurrency 4/replica   fetch → normalize → chunk → hash-gate
kb-embed     concurrency 2/replica   batch-embed (≤128 chunks/call) → write kb_chunk
kb-activate  concurrency 8           validation gate → version flip → cache bust
kb-gc        daily                   superseded-version cleanup, query-log retention
```

- **Idempotency:** deterministic chunk IDs + `ON CONFLICT DO UPDATE`; re-running
  any stage is safe. Job dedupe via deterministic jobIds.
- **Retries:** transient (network, 429, 5xx) → exponential backoff with jitter,
  5 attempts; permanent (parse failure, SSRF block, auth) → version `failed`,
  no retry, `consecutive_failures++`. 3 consecutive failures → source flagged
  `stale` in UI + webhook event `kb.source.stale` (tenant can subscribe via the
  existing outbound-webhook system).
- **Embeddings:** `text-embedding-3-small` (1536-d — matches the existing column
  and index; no migration). Platform key with OpenRouter fallback, as the
  existing `generateEmbeddings` does (`be/.../services/openai.ts:100-131`).
  Batch, and cache embedding calls on `sha256(text)` in Redis (30d TTL) —
  re-syncs of mostly-unchanged content cost near zero.
- **Crash recovery:** BullMQ stalled-job handling + a startup sweep marking
  `building` versions with no live job as `failed` (KB Bridge heartbeat pattern).

---

## 7. Retrieval engine

Two engines behind one API, dispatched by source type; results merged.

### 7.1 Hybrid retrieval (unstructured content)

Promote the playground pipeline (`v2/.../rag-chat.service.ts`) to a production
service in BE, with these stages:

1. **Query understanding (cheap, deterministic):** lowercase/trim; expand with
   conversation context ONLY via the last-user-turn + resolved entities the
   agent already has (no LLM rewrite on the voice path — latency).
   Chat path MAY use the existing contextualization step (it's default-on in the
   playground) when the message is < 4 tokens or pronoun-heavy.
2. **Candidate generation (parallel, single SQL each):**
   - Vector: pgvector HNSW cosine, topK 20, tenant+kb scoped.
   - Lexical: `tsv @@ websearch_to_tsquery('english', $q)` ranked by `ts_rank_cd`,
     topK 20.
3. **Fusion:** Reciprocal Rank Fusion `score = Σ 1/(60 + rank_i)`; dedupe by
   chunk id; keep top 12.
4. **Rerank (chat only, optional flag):** keyword-overlap rerank as in the
   playground (weight 0.3). No LLM reranker in v1 (latency + cost).
5. **Floor & answerability:** normalized top score < **0.4** (the playground's
   `MIN_SIMILARITY_SCORE`, now enforced in production) → `answerable: false`,
   zero chunks returned. This single change is the biggest anti-hallucination
   lever we have: today production injects the 3 least-bad chunks no matter what
   (`agent-run.ts:979-989`).
6. **Trained responses:** Query Training pairs become first-class: embedding
   match ≥ 0.85 against the trained-query vectors short-circuits retrieval and
   returns the curated response with `citation.kind='trained'`. (Today this
   feature is dead in production — `rag-chat.service.ts:725` analysis.)

### 7.2 Structured retrieval (tabular sources)

The KB Bridge engine, in-platform:

- Filters from typed params (`price_max`, `year_min`, categorical equality) run
  as JSONB predicates over `kb_chunk.structured` with **bound** JSON paths;
- categorical value resolution: exact → case-insensitive → alias table
  (chevy→chevrolet…, tenant-extendable) → edit-distance ≤ 2;
- tiered relaxation on zero hits: widen numeric ±15% → drop least-selective
  filter → lexical fallback — returning `close_alternatives` labeled as such,
  never a bare empty result;
- per-tenant alias promotion from the unanswered-query log (§16).

### 7.3 Result contract

```jsonc
{
  "answerable": true,
  "results": [{
    "text": "…chunk text…",
    "score": 0.83,
    "confidence": "high",            // high ≥0.72 · medium ≥0.55 · low ≥0.4 (calibrate in §16)
    "citation": {
      "kind": "source",              // source | trained | structured
      "source_id": "ks_…", "source_name": "Pricing FAQ v3",
      "title": "Refund policy", "url": "https://…", "heading_path": "Billing > Refunds",
      "version": 7, "as_of": "2026-07-13T06:00:00Z"
    },
    "structured": { "price": 28500, "…": "…" }   // structured hits only
  }],
  "close_alternatives": [ /* structured relaxation results */ ],
  "freshness": "fresh",              // fresh | stale (last sync older than 2× schedule)
  "trace_id": "kbq_…"
}
```

Confidence bands and the 0.4 floor start as stated and are **recalibrated from
the golden-set evals** (§16) before GA.

---

## 8. Multi-tenancy

- Every retrieval SQL includes `sub_account_id = $1` from the resolved API
  key/session — denormalized onto `kb_chunk` precisely so no join can widen the
  scope. HNSW + B-tree composite scans keep this fast.
- v3 auth reuses the existing key→subaccount resolution
  (`require-scope.ts:85-93`); internal consumers (agent-run, Telnyx webhook)
  pass the assistant's `subAccountId` explicitly.
- **Postgres RLS as belt-and-suspenders** on `kb_chunk`/`kb_query_log`
  (`USING (sub_account_id = current_setting('app.sub_account_id'))`), enabled
  once the access layer sets the GUC per request. RLS is defense-in-depth; the
  application scoping is the primary control and is what tests assert.
- **Tenant-isolation test suite is a release gate:** for every retrieval/API
  endpoint, a two-tenant fixture asserts tenant B can never read tenant A's
  chunks, sources, logs, or tags — including via filters, tags, and trace ids.
- Noisy-neighbor control: per-tenant retrieval rate limit (Redis token bucket,
  default 20 req/s burst 60 — far above any real agent) and per-tenant ingest
  concurrency cap of 2 jobs.

---

## 9. Low-latency engineering (voice-first)

Budget (voice, worst case allowed): Telnyx webhook timeout is **10s hard**
(`telnyx-tool-translator.ts:627`) but a caller tolerates ~1s of silence — and
there is **no filler audio**: `speakDuringExecution` is dead on the Telnyx path
(verified), so silence is exactly what the caller hears.

| Stage | Budget (p95) |
|---|---|
| TLS + routing (Traefik → Fastify) | 30ms |
| Auth + tenant resolve (Redis-cached key lookup) | 10ms |
| Query embedding (OpenAI) | 120ms — OR 0ms on cache hit |
| Vector + FTS (parallel SQL) | 80ms |
| Fusion + response build | 10ms |
| **Total** | **≤ 250-400ms** |

Tactics, in priority order:
1. **Redis query cache:** key `sha256(tenant|kbset|normalized_query|filters)`,
   TTL 60s, busted on version activation (one `DEL` by kb prefix via key tags).
   Voice callers ask the same 20 questions all day; expect >50% hit rate.
2. **Embedding cache** (same Redis, 30d): identical query text never re-embeds.
3. **Prepared statements + pgbouncer-style pooling** via the existing Neon
   serverless adapter; retrieval uses the **read replica** (v2 already has
   `@prisma/extension-read-replicas` wired — extend to BE).
4. **Parallel candidate generation** (vector ‖ lexical, `Promise.all`).
5. **Degraded ladder** under the 2.5s internal deadline: full hybrid → lexical-
   only (no embedding call) → cached-any → `answerable:false` with explicit
   `degraded:true`. **Always HTTP 200**: the tool proxy retries 5xx up to 4×
   with the caller hanging (`be/.../lib/http.ts:37-100`) — an error body the
   agent can voice beats a retry storm every time.
6. **No cold paths at call time:** connectors, parsing, embedding of content all
   happen at ingest. Retrieval touches only Postgres + Redis.

---

## 10. Automatic ingestion coverage (source matrix)

| Customer has… | Connector | Freshness |
|---|---|---|
| PDFs, Word, slides, sheets | `file` | On upload/re-upload; watch-folder later (§19) |
| A website / help center | `website` | Daily default, configurable to 1h |
| FAQs | `faq` | On edit |
| Inventory/product feed (DMS, Shopify export, …) | `feed` | 15min-24h schedule |
| A database/Supabase | `database` | Schedule |
| An internal system that knows when things change | `push` | ≤ 60s |
| A running e-commerce/CRM app | v2 connectors: Shopify/GHL webhook → `push` under the hood (§19) |

Everything lands in the same version → chunk → activate pipeline; source type
decides chunking + which retrieval engine serves it.

---

## 11. API design (agent + public)

### 11.1 Retrieval (the hot path)

`POST /v3/kb/query` (public, scope `knowledge:READ`) and an internal twin
`POST /internal/kb/query` (service-to-service, no rate limit) used by agent-run,
chat widget, and the Telnyx webhook shim.

```jsonc
// request
{
  "query": "do you have a 2022 tacoma under 30k",
  "kb_ids": ["kb_a", "kb_b"],          // omit → all KBs linked to assistant_id
  "assistant_id": "as_…",              // resolves kb set + tenant on internal path
  "filters": { "tags": ["inventory"], "price_max": 30000, "model": "Tacoma" },
  "top_k": 5,
  "mode": "auto"                        // auto | semantic | structured
}
// response: §7.3 shape
```

- **Multi-KB is native** — this kills today's one-KB-per-voice-agent limitation
  (`telnyx-agent.ts:92-99`): the Telnyx agent's `knowledge_base` webhook is
  repointed to a shim `GET /knowledge-base/retrieval/:assistantId` that calls
  the internal query API across ALL linked KBs and returns the legacy
  `{recommendations:[…]}` shape (with citations appended inline as
  `"…text… [Pricing FAQ, updated Jul 13]"`), so existing agents improve without
  re-provisioning. New-style agents get the full JSON contract.
- Existing per-query voice billing ($0.01 via Redis session counter,
  `routes/knowledge-base.ts:11-48`) is preserved in the shim.
- **Timeout/retry contract with the tool proxy (verified, non-negotiable):**
  answer < 2.5s; 200-always for handled errors; 404 only for auth failure
  (4xx is not retried, 5xx/429 are — `lib/http.ts:96-100`).

### 11.2 Management (public v3)

```
POST   /v3/kb                          create KB
POST   /v3/kb/:id/sources              create source (connector + config) — ENQUEUES INGESTION (bug fix)
POST   /v3/kb/:id/sources/:sid/refresh force re-sync now
POST   /v3/kb/:id/sources/:sid/content push content (real-time path, HMAC optional)
GET    /v3/kb/:id/sources/:sid/versions        list versions + status
POST   /v3/kb/:id/sources/:sid/rollback        flip to previous version
GET    /v3/kb/:id/analytics            query volume, answerable rate, top unanswered
POST   /v3/kb/:id/assign  /remove      assistant assignment (exists)
```

Envelope, scopes, and rate limiting follow the existing v3 conventions
(`{data,error,request_id}`; 150 req/10s + 100k/day per workspace+subaccount —
`rate-limit-config.service.ts:20-22`). Webhook events emitted through the
existing outbound webhook system: `kb.sync.completed`, `kb.sync.failed`,
`kb.source.stale` (idempotency keys use `-` separators — BullMQ jobId rule).

---

## 12. Context optimization & anti-hallucination

1. **Answerability floor** (§7.1.5) — no chunks below 0.4 ever reach the prompt.
2. **Retrieval as a tool, framed with a no-fabrication guard**: the platform
   already appends a NO_FABRICATION_GUARD to webhook tools
   (`telnyx-tool-translator.ts:585-591`) and the proxy error contract instructs
   "do NOT synthesize values" — the KB answer contract extends this: system
   prompt for KB-enabled agents gains: *"Answers about {domain} MUST come from
   the knowledge tool result. If answerable=false, say you don't have that
   information and offer to take a message. Read speech_hint aloud when present."*
3. **Citations in-band**: chunk text delivered with `[source, as_of]` suffix so
   even models that ignore JSON structure carry provenance into answers.
4. **Freshness honesty**: `freshness:"stale"` → agent phrase "as of our last
   update". Deterministic, template-level — same doctrine as the platform's
   date-resolution rule (never let the model compute dates; never let it guess
   freshness).
5. **Compact context**: top 5 chunks max, ≤ 1200 chars total on voice (the
   verified static-KB behavior of dumping ~3KB unranked is strictly worse);
   structured answers pre-summarized in `speech_hint` so the voice model reads
   rather than reasons.
6. **Query training as guardrails**: curated answers for known-critical
   questions (pricing, refunds, compliance) short-circuit retrieval (§7.1.6) —
   giving CS a direct lever when an agent answers something badly.

---

## 13. Caching & scalability

- **Capacity math (targets from §2):** 5M chunks × (1536×4B vector + text +
  tsv) ≈ 60-80GB — comfortably one Neon instance; HNSW query cost is
  logarithmic. 200 retrievals/s × ~3 SQL each = ~600 qps against the read
  replica: fine. Embedding at ingest is the only meaningful external spend and
  is hash-gated (§5) + cached (§6).
- **Cache layers:** (1) query-result cache 60s; (2) embedding cache 30d;
  (3) API-key→tenant resolution cache 60s (exists for rate-limit overrides —
  same pattern); (4) assistant→kb-set cache 60s, busted on assignment change.
- **Horizontal scale:** retrieval is stateless → scale BE replicas (already 5
  behind Traefik); workers scale by BullMQ concurrency knobs; Redis and
  Postgres are managed services with their own scaling paths (Upstash, Neon).
- **Backpressure:** ingest queues bounded (10k jobs); over-limit push requests
  get 429 with Retry-After (management API only — never the retrieval path).

---

## 14. Reliability: failover, retries, backups, DR

- **Backups:** Neon PITR (continuous WAL) — RPO ≤ 5min. Nightly logical dump of
  KB tables to R2/S3 (30-day retention) as provider-independent insurance.
  Redis is cache/queue only: losable; queues drain from Postgres state on
  restart (every in-flight version is reconstructible from `kb_source_version`).
- **Restore runbook (tested quarterly):** restore Neon branch to T, repoint
  read replica, replay `building` versions. RTO target ≤ 30min.
- **Failure modes & behavior:**
  | Failure | Behavior |
  |---|---|
  | OpenAI embeddings down | Ingest pauses (retry/backoff); retrieval degrades to lexical-only automatically (§9.5) — **customers still get answers** |
  | Redis down | Caches miss (slower, correct); BullMQ paused; scheduler catches up on recovery |
  | Read replica down | Fall back to primary (feature flag) |
  | Postgres down | Full outage of KB — surfaced via `/healthz` + status page; agents receive `answerable:false, degraded:true` from the 200-always contract, so calls don't hang |
  | One BE replica dies | Traefik routes around it; BullMQ stalled jobs re-run |
- **Single-EC2 risk (flagged):** the BE currently runs all replicas on ONE EC2
  instance (BE CLAUDE.md). For "primary source of truth" status, that box is
  the availability ceiling. Recommendation: second instance behind the same
  Traefik or move retrieval routes to a second small host — decision for the
  infra owner, called out here so it's explicit.

---

## 15. Security

- **AuthN/AuthZ:** v3 API keys with scopes (existing); internal endpoints on the
  private network path only; per-source HMAC for push ingestion; the Telnyx shim
  keeps its session-header billing key.
- **Encryption:** TLS everywhere (Traefik ACME, exists); connector credentials
  AES-256-GCM at rest (key in env/SSM, key-id prefix for rotation — KB Bridge
  envelope format); Neon encrypts at rest.
- **Tenant isolation:** §8 (application scoping + RLS + release-gate tests).
- **SSRF:** §5 guard on all fetching connectors — non-optional.
- **Injection surfaces:** JSONB paths bound, never interpolated (column names
  are tenant data); FTS queries via `websearch_to_tsquery` (safe parser);
  ident-validation on the database connector.
- **Secrets hygiene:** logger redaction on `key|secret|token|authorization|connection`
  patterns (v2's logger already redacts — extend BE's); tool headers containing
  secrets are readable via `GET /v3/tools/:id` today (verified) — document this
  to customers and scope Live KB secrets out of tool headers entirely (retrieval
  is internal; only KB Bridge-style external tools use header secrets).
- **Audit log:** append-only `audit_log` for: KB/source CRUD, version rollbacks,
  key changes, permission/assignment changes, admin overrides — with actor,
  tenant, timestamp, detail JSON. Surfaced in the UI for the tenant, queryable
  for support.
- **Data deletion:** source delete → versions+chunks cascade; tenant offboarding
  job purges chunks, logs, caches; embedding cache keys are content-addressed
  (no tenant data in keys).

---

## 16. Observability & retrieval quality

**Logging:** structured JSON per retrieval with `trace_id`, tenant, channel,
latency by stage, cache hits, top score, answerable — into the existing Axiom /
GlitchTip stack (errors → GlitchTip project `backend`, per BE CLAUDE.md).

**Metrics (dashboards + alerts):**
- Latency p50/p95/p99 by channel; error rate; cache hit rates.
- Ingest: sync success rate, freshness lag per source, queue depth, embedding
  spend/day.
- Quality: answerable rate, zero-result rate, average top score, per-tenant
  unanswered-query leaderboard.
- Alerts: p95 > 500ms 5min; sync failure spike; queue depth > 5k; freshness lag
  > 2× schedule for any source with traffic.

**Retrieval quality program (what makes accuracy improve over time):**
1. **Golden set:** per major vertical (dealership, ecommerce, services), 50-100
   question→expected-source pairs, run nightly in CI against a seeded tenant;
   track recall@5 and MRR; regression fails the build.
2. **Online signals:** `kb_query_log.answerable=false` clusters → weekly
   "unanswered queries" digest per tenant (the accuracy flywheel: one click
   promotes an unanswered query to a Query-Training pair or alias).
3. **Confidence calibration:** sampled human-labeled (or LLM-judge, offline)
   relevance on ~500 logged queries/month → adjust band thresholds.
4. **Voice-quality tie-in:** join `kb_query_log` to call transcripts by
   `call_control_id` to find calls where low-confidence answers correlate with
   escalations.

---

## 17. Rollout, testing, CI/CD

**Environments & flags:** everything behind per-tenant feature flags:
`livekb.retrieval` (new engine serves production queries), `livekb.dual_read`
(shadow mode), per-connector flags.

**Phased rollout:**
- **P0 — Foundations (weeks 1-3):** schema (+parity mirror), ingestion pipeline
  + version model, fix v3 PENDING bug, deterministic chunk IDs, pgvector HNSW
  index build, backfill job (re-index existing COMPLETE sources from
  `knowledgeChunk` text — embeddings already in Postgres where present).
- **P1 — Retrieval engine (weeks 3-6):** hybrid engine + floor + citations;
  `internal/kb/query`; **dual-read shadow mode**: production chat queries run
  BOTH old (Pinecone top-3) and new engines, log both, serve old. Compare
  answerable/overlap/latency on real traffic for ≥1 week.
- **P2 — Cutover (weeks 6-8):** flip `livekb.retrieval` for internal tenants →
  design partners (a dealership + an ecommerce tenant) → all. Voice shim
  repointed. Old Pinecone path kept warm behind an instant-rollback flag for
  30 days, then decommissioned.
- **P3 — Live data (weeks 8-12):** structured sources (feed/database/push),
  filters in the query API, KB Bridge-pattern tool generation for structured
  sources; analytics UI; connector SDK docs.

**Testing pyramid:**
- Unit: chunkers, inference, fusion math, gates, SSRF guard, HMAC.
- Integration: pipeline end-to-end per connector against fixtures; version
  swap/rollback; tenant-isolation suite (release gate, §8).
- Retrieval evals: golden set in CI (nightly + pre-release).
- Load: k6 at 3× target qps on a staging Neon branch; soak the voice shim at
  p95 budget.
- Chaos drills: kill Redis, kill replica, throttle OpenAI — assert degraded
  ladder behavior (§9.5, §14).

**CI/CD:** existing GitHub Actions on `main` (BE deploys via Docker rolling
update — zero-downtime path already in place). Add: schema-parity check (exists,
will trip on new models until mirrored), golden-set eval job, migration step
gated by the Prisma safety rules (no `--accept-data-loss`, ever — both CLAUDE.mds).

**Runbooks (docs/runbooks/ in BE):** stale-source triage; failed-sync triage;
rollback a bad version; restore-from-backup; "agent quoting stale price" triage
(trace_id → version → source diff); embedding-provider outage.

---

## 18. Developer experience

- One `docker compose up` dev stack: Postgres (pgvector), Redis, MinIO, the BE
  service, seeded demo tenant with a dealership CSV + crawled demo site.
- `MOCK_EMBEDDINGS=1` mode (hash-based pseudo-vectors) so tests and local dev
  never need API keys.
- Connector SDK (§19) with a fixture-based test harness: `npx kb-connector test ./my-connector`.
- The retrieval API is self-describing: `GET /v3/kb/query/schema` returns the
  JSON schema + a copy-pasteable example per mode.

---

## 19. Future extensibility

- **Connector SDK:** the `Connector` interface (§5) + manifest
  (`{name, configSchema (zod), schedules, docs}`) — new connectors (Google
  Drive, Notion, Zendesk, Shopify, GHL custom objects) are additive modules;
  registry-driven UI so the portal picks them up without UI changes.
- **Push-webhook adapters:** thin translators (Shopify product-update webhook →
  `push` content) — each ~100 lines on the existing seam.
- **Per-source visibility ACLs** on the `kb_source_tag` hook (§4).
- **LLM reranker + HyDE** as opt-in retrieval flags (already scaffolded in the
  playground pipeline; latency-budgeted for chat only).
- **Cross-lingual:** swap `to_tsvector('english')` for per-KB language config +
  multilingual embedding model — isolated to two functions by design.
- **KB Bridge (external portal)** remains the fast path for prospects not yet on
  the platform and the reference implementation for structured search; once P3
  lands, its connectors map 1:1 onto platform source types.

---

## Appendix A — Decisions & rationale (quick reference)

| Decision | Why |
|---|---|
| Postgres/pgvector as system of record (Pinecone retired post-migration) | Column+index already exist; one store = atomic versioning, one DR story, tenant scoping in SQL; namespace-fan-out queries (1+N per message today) disappear |
| Version-flip freshness, not in-place updates | Atomic, instantly rollbackable, idempotent, cheap to reason about — proven in KB Bridge |
| Hybrid RRF over pure vector | Verified failure of pure cosine on numeric/exact queries; lexical leg also gives the embedding-outage degraded mode |
| Structured rows as first-class (no chunking) | The single biggest accuracy win for dealership/ecommerce; verified CSV-as-text failure |
| 0.4 floor + answerable flag | Biggest anti-hallucination lever; already validated in the playground |
| 200-always + 2.5s deadline on retrieval | Verified proxy retry amplification (15s×4 vs Telnyx 10s) — 5xx makes callers hang |
| Fix v3 PENDING in P0 | The public API currently produces dead sources; Live KB credibility requires the API to work |
| Feature-flag dual-read cutover | Retrieval quality changes are risky; shadow mode gives real-traffic evidence before any customer feels it |

## Appendix B — Verified source citations (baseline claims)

- Chat RAG path: `be/packages/api/src/services/agent-run.ts:937-999, 1152-1157`
- Voice KB webhook + billing: `be/packages/api/src/routes/knowledge-base.ts:11-144`
- One-KB-per-voice-agent: `be/packages/api/src/services/telnyx-agent.ts:92-99, 755-783`
- Tool proxy contract/timeouts: `be/packages/api/src/services/tool-proxy.service.ts:415-618`, `be/packages/api/src/lib/http.ts:37-100`, `be/packages/api/src/services/telnyx-tool-translator.ts:593-627`
- Playground hybrid pipeline: `v2/src/server/services/knowledge/rag-chat.service.ts:66-117, 725, 1026`
- Chunking / CSV-as-text: `v2/src/server/services/knowledge/chunking.service.ts:17-18`, `v2/src/server/services/knowledge/unstructured.service.ts:106`
- Freshness/duplication bugs: `v2/src/server/services/knowledge/knowledge-processor.service.ts:62, 104, 341-369`
- v3 PENDING bug: `be/packages/api/src/routes/v3/knowledge.ts:282-284`; no sweeper in either repo (verified by search)
- v3 scopes/rate limits: `be/packages/api/src/middleware/require-scope.ts:71-93`, `be/packages/api/src/services/rate-limit-config.service.ts:20-22`
