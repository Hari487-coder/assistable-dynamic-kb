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
