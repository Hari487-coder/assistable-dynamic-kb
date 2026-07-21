import { DatabaseSync } from "node:sqlite";

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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  subaccount_id TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('website','feed','csv','database','webtable')),
  name TEXT NOT NULL, config_ct TEXT NOT NULL,
  schedule_minutes INTEGER NOT NULL DEFAULT 1440,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'never_synced'
    CHECK (status IN ('never_synced','syncing','active','stale','error')),
  active_batch_id TEXT, prev_batch_id TEXT,
  column_meta_json TEXT NOT NULL DEFAULT '[]',
  last_sync_at TEXT, next_run_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  push_secret TEXT
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
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts_vocab USING fts5vocab('items_fts','row');
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
  relaxations TEXT, took_ms INTEGER, ok INTEGER NOT NULL,
  outcome TEXT, flags TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_source ON tool_calls (source_id, ts DESC);
-- Questions real callers asked, replayed daily to prove they still get an
-- answer. One row per distinct question per source (see answer-checks.js for
-- why answerability, not values, is what gets asserted).
CREATE TABLE IF NOT EXISTS answer_checks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
  query TEXT NOT NULL, args_json TEXT NOT NULL, baseline_json TEXT,
  origin TEXT NOT NULL DEFAULT 'auto', status TEXT, detail TEXT,
  created_at TEXT NOT NULL, last_run_at TEXT,
  flagged_at TEXT, flag_note TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_checks_q ON answer_checks (source_id, query);
CREATE INDEX IF NOT EXISTS idx_answer_checks_status ON answer_checks (source_id, status);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  user_id TEXT, event TEXT NOT NULL, detail_json TEXT
);
`;

export function openDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Idempotent in-place migrations for databases created by older versions. */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(sources)").all().map((c) => c.name);
  if (!cols.includes("push_secret")) db.exec("ALTER TABLE sources ADD COLUMN push_secret TEXT");
  const connCols = db.prepare("PRAGMA table_info(connections)").all().map((c) => c.name);
  if (!connCols.includes("subaccount_id")) db.exec("ALTER TABLE connections ADD COLUMN subaccount_id TEXT");
  const callCols = db.prepare("PRAGMA table_info(tool_calls)").all().map((c) => c.name);
  if (!callCols.includes("outcome")) db.exec("ALTER TABLE tool_calls ADD COLUMN outcome TEXT");
  if (!callCols.includes("flags")) db.exec("ALTER TABLE tool_calls ADD COLUMN flags TEXT");
  // The type CHECK is baked into the table SQL; rebuild once to admit 'webtable'.
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'").get().sql;
  if (!tableSql.includes("webtable")) {
    db.exec("PRAGMA foreign_keys = OFF;");
    tx(db, () => {
      db.exec(`CREATE TABLE sources_migrated (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('website','feed','csv','database','webtable')),
        name TEXT NOT NULL, config_ct TEXT NOT NULL,
        schedule_minutes INTEGER NOT NULL DEFAULT 1440,
        secret TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'never_synced'
          CHECK (status IN ('never_synced','syncing','active','stale','error')),
        active_batch_id TEXT, prev_batch_id TEXT,
        column_meta_json TEXT NOT NULL DEFAULT '[]',
        last_sync_at TEXT, next_run_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        push_secret TEXT
      )`);
      db.exec("INSERT INTO sources_migrated SELECT * FROM sources");
      db.exec("DROP TABLE sources");
      db.exec("ALTER TABLE sources_migrated RENAME TO sources");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sources_due ON sources (next_run_at) WHERE status != 'syncing'");
    });
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Manual transaction helper (node:sqlite has no db.transaction()). */
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
