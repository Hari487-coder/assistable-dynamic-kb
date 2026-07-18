import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { runSync, runRetention } from "../src/sync/engine.js";
import { searchStructured } from "../src/search/structured.js";
import { inferColumnMeta } from "../src/ingest/normalize.js";

// Deterministic 5,000-row synthetic dealership inventory: 10 makes, 60 models,
// realistic prices/mileage, unique VINs — the "handle 1000+ records" proof.
const MAKES = ["Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz", "Subaru", "Hyundai", "Kia"];
const MODELS = ["Tacoma", "Tundra", "Camry", "Corolla", "RAV4", "Civic", "Accord", "CR-V", "F-150", "Escape",
  "Silverado", "Equinox", "Altima", "Rogue", "3 Series", "X5", "C-Class", "GLE", "Outback", "Forester",
  "Elantra", "Tucson", "Sorento", "Sportage", "Highlander", "Pilot", "Ranger", "Tahoe", "Frontier", "X3"];
const COLORS = ["Silver", "Black", "White", "Red", "Blue", "Gray", "Green", "Bronze"];
const N = 5000;

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRows() {
  const rand = mulberry(42);
  const rows = [];
  for (let i = 0; i < N; i++) {
    const make = MAKES[Math.floor(rand() * MAKES.length)];
    const model = MODELS[Math.floor(rand() * MODELS.length)];
    const year = 2015 + Math.floor(rand() * 10);
    const price = 8000 + Math.floor(rand() * 72000);
    rows.push({
      make, model, year: String(year),
      price: `$${price.toLocaleString("en-US")}`,
      mileage: String(5000 + Math.floor(rand() * 120000)),
      color: COLORS[Math.floor(rand() * COLORS.length)],
      vin: `VIN${String(i).padStart(6, "0")}`,
    });
  }
  return rows;
}

const noopLog = { info() {}, warn() {}, error() {} };
const KEY = Buffer.alloc(32, 4).toString("base64");
let db, source, rows;

before(async () => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES ('big','u1','csv','Big Inventory',?,'sec','2026-01-01')`)
    .run(encryptSecret(JSON.stringify({}), KEY));
  rows = buildRows();
  const started = Date.now();
  const r = await runSync({
    db, logger: noopLog, config: { encryptionKey: KEY, dataDir: "./data" },
    connectors: { csv: async () => ({ rows }) },
  }, "big", {});
  const ingestMs = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(r.itemsCount, N);
  assert.ok(ingestMs < 15_000, `ingest of ${N} rows took ${ingestMs}ms (budget 15s)`);
  source = db.prepare("SELECT * FROM sources WHERE id='big'").get();
});

test("column inference at scale: 30 models stay filterable, VIN stays text", () => {
  const meta = JSON.parse(source.column_meta_json);
  const by = Object.fromEntries(meta.map((c) => [c.name, c]));
  assert.equal(by.model.kind, "categorical", "60-model column must remain filterable");
  assert.ok(by.model.distincts.length >= 25);
  assert.equal(by.vin.kind, "text", "unique IDs must not become categoricals");
  assert.equal(by.price.kind, "numeric");
});

test("accuracy at 5k rows: filters return exactly what SQL says", () => {
  const r = searchStructured(db, source, { query: "", filters: { make: "Toyota", model: "Tacoma", price_max: 30000 } });
  const truth = rows.filter((x) => x.make === "Toyota" && x.model === "Tacoma" &&
    Number(x.price.replace(/[$,]/g, "")) <= 30000).length;
  assert.equal(r.resultCount, truth, "result_count must equal ground truth");
  assert.ok(r.items.length <= 5);
  assert.ok(r.items.every((i) => i.structured.price <= 30000 && i.structured.model === "Tacoma"));
});

test("latency at 5k rows: p95 under 150ms across mixed query shapes", () => {
  const queries = [
    { query: "", filters: { make: "Honda", price_max: 25000 } },
    { query: "cheapest bmw you have", filters: {} },
    { query: "any fords under 30 thousand", filters: {} },
    { query: "2022 rav4", filters: {} },
    { query: "", filters: { model: "silverado" } },              // case-insensitive
    { query: "", filters: { make: "chevy" } },                   // alias
    { query: "", filters: { model: "tocoma" } },                 // fuzzy
    { query: "newest mercedes", filters: {} },
    { query: "red civic under 20k", filters: {} },
    { query: "", filters: { make: "Kia", model: "Sorento", price_max: 15000 } }, // likely relaxation path
  ];
  // Gate on CPU time, not wall time: node:test runs sibling files in separate
  // processes, so wall clock here measures OS scheduling contention, while
  // process-local CPU time measures the engine itself. (Queries are fully
  // synchronous, so the cpuUsage delta is exactly the query's compute.)
  // The pre-optimization code measured 2,300ms on this gate; budget is 150ms.
  const BUDGET_MS = 150;
  const times = [];
  for (let round = 0; round < 6; round++) {
    for (const q of queries) {
      const c0 = process.cpuUsage();
      const r = searchStructured(db, source, q);
      const c1 = process.cpuUsage(c0);
      times.push((c1.user + c1.system) / 1000);
      assert.ok(r.resultCount > 0 || r.alternatives.length > 0, `never empty-handed: ${JSON.stringify(q)}`);
    }
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`      benchmark on ${N} rows (CPU time): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
  assert.ok(p95 < BUDGET_MS, `p95 ${p95.toFixed(1)}ms CPU exceeds ${BUDGET_MS}ms budget`);
});

test("retention prunes old logs but keeps recent ones", () => {
  db.prepare("INSERT INTO tool_calls (source_id,ts,args_json,ok) VALUES ('big','2025-01-01T00:00:00Z','{}',1)").run();
  db.prepare("INSERT INTO tool_calls (source_id,ts,args_json,ok) VALUES ('big',?, '{}',1)").run(new Date().toISOString());
  const pruned = runRetention(db, noopLog);
  assert.ok(pruned.calls >= 1);
  assert.equal(db.prepare("SELECT count(*) c FROM tool_calls WHERE source_id='big'").get().c, 1);
});

test("50k item cap rejects oversized sources with a clear permanent error", async () => {
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,created_at)
              VALUES ('huge','u1','csv','Too Big',?,'sec','2026-01-01')`)
    .run(encryptSecret(JSON.stringify({}), KEY));
  const fake = { length: 60_000 };
  const r = await runSync({
    db, logger: noopLog, config: { encryptionKey: KEY, dataDir: "./data" },
    connectors: { csv: async () => ({ rows: Object.assign([], { length: 60_000 }) }) },
  }, "huge", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /limit is 50000/);
});
