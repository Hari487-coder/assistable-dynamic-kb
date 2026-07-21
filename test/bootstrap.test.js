import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { bootstrapFromEnv } from "../src/bootstrap.js";
import { verifyPassword } from "../src/auth.js";
import { AssistableClient } from "../src/assistable/client.js";
import { parseCsvItems } from "../src/connectors/csv.js";
import { searchStructured } from "../src/search/structured.js";

const noop = { info() {}, warn() {}, error() {} };
const KEY = Buffer.alloc(32, 5).toString("base64");
const CSV = "material,price_per_kg\nBare Bright Copper,£7.20\nHeavy Brass,£4.10";

const PLAN = {
  email: "Owner@Self.Host",
  password: "longenough1",
  assistable_api_key: "ak-bootstrap-123",
  subaccount_id: "sub-1",
  sources: [{ type: "csv", name: "Scrap Prices", csv_text: CSV, schedule_minutes: 60, assistant_ids: ["mock-assistant-1"] }],
};

function deps(bootstrap) {
  const db = openDb(":memory:");
  const client = new AssistableClient({ apiKey: "x", mock: true, logger: noop });
  return {
    db, client,
    args: {
      db, logger: noop,
      config: { encryptionKey: KEY, baseUrl: "http://t", dataDir: "./data", bootstrap },
      connectors: { csv: async (cfg) => parseCsvItems(cfg.csv_text) },
      makeClient: () => client,
    },
  };
}

test("empty instance + BOOTSTRAP -> account, connection, source and tool all restored", async () => {
  const { db, client, args } = deps(JSON.stringify(PLAN));
  const out = await bootstrapFromEnv(args);
  assert.equal(out.ran, true);
  assert.equal(out.sources, 1);
  assert.equal(out.tools, 1);

  const user = db.prepare("SELECT * FROM users").get();
  assert.equal(user.email, "owner@self.host", "email lowercased");
  assert.ok(await verifyPassword("longenough1", user.password_hash), "owner can log in with the planned password");

  const conn = db.prepare("SELECT * FROM connections").get();
  assert.equal(conn.status, "verified");
  assert.ok(conn.api_key_ct.startsWith("v1:") && !conn.api_key_ct.includes("ak-bootstrap"), "key stored encrypted");

  const source = db.prepare("SELECT * FROM sources").get();
  assert.equal(source.status, "active", "first sync ran");
  const tool = db.prepare("SELECT * FROM tools").get();
  assert.match(tool.tool_id, /^mock-tool-/);
  assert.deepEqual(JSON.parse(tool.assistant_ids_json), ["mock-assistant-1"]);
  assert.ok(client.mockCalls.some((c) => c.path.endsWith("/assign")), "tool attached to the assistant");

  // The restored source actually answers - the whole point of self-healing.
  const r = searchStructured(db, source, { query: "bare bright copper price" });
  assert.equal(r.items[0].structured.price_per_kg, 7.2);
});

test("does nothing on an instance that already has an account", async () => {
  const { db, args } = deps(JSON.stringify(PLAN));
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')").run();
  const out = await bootstrapFromEnv(args);
  assert.equal(out.ran, false);
  assert.equal(db.prepare("SELECT count(*) c FROM users").get().c, 1, "no second account");
});

test("no BOOTSTRAP env -> no-op", async () => {
  const { args } = deps(null);
  assert.equal((await bootstrapFromEnv(args)).ran, false);
});

test("invalid JSON or weak password never crashes the boot", async () => {
  const bad = deps("{not json");
  assert.equal((await bootstrapFromEnv(bad.args)).ran, false);
  const weak = deps(JSON.stringify({ ...PLAN, password: "short" }));
  assert.equal((await bootstrapFromEnv(weak.args)).ran, false);
  assert.equal(weak.db.prepare("SELECT count(*) c FROM users").get().c, 0);
});

test("a source whose first sync fails is still recreated and scheduled to retry", async () => {
  const { db, args } = deps(JSON.stringify({
    ...PLAN,
    sources: [{ type: "webtable", name: "Flaky site", url: "https://down.example.com/prices", schedule_minutes: 60, assistant_ids: [] }],
  }));
  args.connectors = { webtable: async () => { throw new Error("HTTP 503"); } };
  const out = await bootstrapFromEnv(args);
  assert.equal(out.ran, true);
  assert.equal(out.sources, 1);
  assert.ok(out.warnings.some((w) => /first sync failed/.test(w)));
  const source = db.prepare("SELECT * FROM sources").get();
  assert.ok(source.next_run_at, "transient failure keeps the retry schedule");
});
