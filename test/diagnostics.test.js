import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { inferColumnMeta, rowToItem } from "../src/ingest/normalize.js";
import { buildDiagnosticBundle, scrubText } from "../src/diagnostics.js";
import { diagnose } from "../src/analytics/diagnose.js";

// Every one of these is a real secret shape that lives in the schema. If any
// string here ever appears in a bundle, the export has leaked.
const SECRETS = {
  passwordHash: "$2b$12$SUPERSECRETPASSWORDHASHVALUE0000000000000000000000",
  apiKeyCt: "APIKEYCIPHERTEXT-must-never-leave-the-box",
  configCt: "CONFIGCIPHERTEXT-with-db-credentials-inside",
  toolSecret: "TOOLSECRET0000000000000000000000",
  pushSecret: "PUSHSECRET0000000000000000000000",
  sessionToken: "SESSIONTOKENHASH0000000000000000",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  setupToken: "SETUPTOKEN-deployer-only",
};

const CONFIG = {
  baseUrl: "https://live-kb-octz.onrender.com",
  signups: "first-only",
  mockAssistable: false,
  encryptionKey: SECRETS.encryptionKey,
  encryptionKeyFromEnv: false,
  setupToken: SECRETS.setupToken,
  dataDir: "./data",
};

function seed({ moneyAsText = false } = {}) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','owner@shop.co',?,?)").run(SECRETS.passwordHash, now);
  db.prepare("INSERT INTO sessions (token_hash,user_id,created_at,last_seen_at,expires_at) VALUES (?,'u1',?,?,?)")
    .run(SECRETS.sessionToken, now, now, now);
  db.prepare("INSERT INTO connections (user_id,api_key_ct,label,status,created_at,updated_at) VALUES ('u1',?,'key','verified',?,?)")
    .run(SECRETS.apiKeyCt, now, now);

  // Prices written as prose: unparseable, and the exact state this diagnostic
  // exists to catch. (POA-style placeholders and bands are handled at ingest
  // now, so they no longer produce a text money column.)
  const rows = moneyAsText
    ? [{ material: "Copper", price_per_kg: "seven pounds fifty" }, { material: "Lead", price_per_kg: "one sixty a kilo" }, { material: "Brass", price_per_kg: "ask for today's rate" }]
    : [{ material: "Bare Bright Copper", price_per_kg: "£7.20" }, { material: "Lead", price_per_kg: "£1.60" }];
  const meta = inferColumnMeta(rows);
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,push_secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('src-1234-abcd','u1','webtable','Scrap Prices',?,?,?,'active','b1',?,?,1440,?)`)
    .run(SECRETS.configCt, SECRETS.toolSecret, SECRETS.pushSecret, JSON.stringify(meta), now, now);
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  for (const row of rows) {
    const it = rowToItem(row, meta);
    ins.run(crypto.randomUUID(), "src-1234-abcd", "b1", it.title, it.body, JSON.stringify(it.structured));
  }
  db.prepare("INSERT INTO tools (source_id,tool_id,assistant_ids_json,created_at,updated_at) VALUES ('src-1234-abcd','tool_1','[]',?,?)").run(now, now);
  db.prepare(`INSERT INTO tool_calls (source_id,ts,args_json,result_count,relaxations,took_ms,ok,outcome,flags)
              VALUES ('src-1234-abcd',?,?,0,'[]',30,1,'no_match','')`)
    .run(now, JSON.stringify({ query: "call me on 07700 900123 or bob@shop.co about copper under 30k" }));
  return db;
}

test("scrubText removes contact details but keeps the numbers a question is about", () => {
  const s = scrubText("email bob@shop.co or ring 07700 900123 about a 2022 tacoma under 30k at £7.20");
  assert.ok(!s.includes("bob@shop.co"), "email must go");
  assert.ok(!s.includes("900123"), "phone must go");
  assert.ok(s.includes("2022"), "a year is the question, not PII");
  assert.ok(s.includes("30k"), "a budget is the question, not PII");
  assert.ok(s.includes("7.20"), "a price is the question, not PII");
});

test("no secret in the database ever reaches the bundle", () => {
  const db = seed();
  for (const opts of [{}, { includeData: true }, { includeQuestions: false }, { includeData: true, includeQuestions: true }]) {
    const serialized = JSON.stringify(buildDiagnosticBundle(db, CONFIG, opts));
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!serialized.includes(value), `bundle leaked ${name} with options ${JSON.stringify(opts)}`);
    }
  }
});

test("bundle reports that a setup token exists without revealing it", () => {
  const b = buildDiagnosticBundle(seed(), CONFIG);
  assert.equal(b.instance.setupTokenSet, true);
  assert.equal(b.instance.baseUrlHost, "live-kb-octz.onrender.com");
});

test("customer questions are included but scrubbed, and can be opted out entirely", () => {
  const db = seed();
  const withQ = buildDiagnosticBundle(db, CONFIG);
  const asked = withQ.sources[0].recentCalls[0].question;
  assert.ok(asked.includes("copper"), "the diagnostic content survives");
  assert.ok(!asked.includes("bob@shop.co") && !asked.includes("900123"), "PII does not");

  const withoutQ = buildDiagnosticBundle(db, CONFIG, { includeQuestions: false });
  assert.deepEqual(withoutQ.sources[0].recentCalls, []);
  assert.deepEqual(withoutQ.sources[0].quality.unanswered, []);
});

test("business data is withheld unless explicitly opted in", () => {
  const db = seed();
  const lean = buildDiagnosticBundle(db, CONFIG);
  assert.equal(lean.sources[0].sampleRows, undefined, "no rows by default");
  assert.ok(!JSON.stringify(lean).includes("Bare Bright Copper"), "no row content by default");

  const full = buildDiagnosticBundle(db, CONFIG, { includeData: true });
  assert.ok(full.sources[0].sampleRows.length > 0, "opted in, rows appear");
});

test("column structure is always shared, because it is the diagnosis", () => {
  const b = buildDiagnosticBundle(seed(), CONFIG);
  const cols = Object.fromEntries(b.sources[0].columns.map((c) => [c.name, c]));
  assert.equal(cols.price_per_kg.kind, "numeric");
  assert.equal(cols.price_per_kg.currency, "£");
});

test("diagnose catches a price column that parsed as text", () => {
  const b = buildDiagnosticBundle(seed({ moneyAsText: true }), CONFIG);
  const hit = diagnose(b).find((f) => f.id === "money-column-is-text");
  assert.ok(hit, "prices written as prose must be flagged");
  assert.equal(hit.severity, "critical");
});

test("a marketplace column of bands and placeholders is NOT flagged", () => {
  const db = seed();
  const meta = inferColumnMeta([
    { yard: "A", price_per_kg: "£8.20 – £8.70" },
    { yard: "B", price_per_kg: "£7.70 – £7.80" },
    { yard: "C", price_per_kg: "POA" },
  ]);
  db.prepare("UPDATE sources SET column_meta_json = ? WHERE id = 'src-1234-abcd'").run(JSON.stringify(meta));
  const findings = diagnose(buildDiagnosticBundle(db, CONFIG));
  assert.ok(!findings.find((f) => f.id === "money-column-is-text"),
    "banded prices with some yards unpriced are healthy, not broken");
});

test("diagnose catches a tool attached to no assistants, and the on-disk key", () => {
  const findings = diagnose(buildDiagnosticBundle(seed(), CONFIG));
  assert.ok(findings.find((f) => f.id === "tool-unattached"), "a tool nobody can call is critical");
  assert.ok(findings.find((f) => f.id === "key-on-disk"));
  assert.equal(findings[0].severity, "critical", "criticals sort first");
});

test("diagnose catches mock mode, the misconfig that silently creates no tools", () => {
  const b = buildDiagnosticBundle(seed(), { ...CONFIG, mockAssistable: true });
  assert.ok(diagnose(b).find((f) => f.id === "mock-mode"));
});

test("a healthy instance produces no critical findings", () => {
  const db = seed();
  db.prepare("UPDATE tools SET assistant_ids_json = '[\"a1\"]' WHERE source_id = 'src-1234-abcd'").run();
  const b = buildDiagnosticBundle(db, { ...CONFIG, encryptionKeyFromEnv: true });
  assert.deepEqual(diagnose(b).filter((f) => f.severity === "critical"), []);
});
