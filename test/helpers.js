import express from "express";
import { openDb } from "../src/db.js";
import { createDashboardRouter } from "../src/routes/dashboard.js";
import { createToolApiRouter } from "../src/routes/tool-api.js";
import { AssistableClient } from "../src/assistable/client.js";
import { cookieParser } from "../src/auth.js";
import { parseCsvItems } from "../src/connectors/csv.js";

const noopLog = { info() {}, warn() {}, error() {} };
const KEY = Buffer.alloc(32, 5).toString("base64");

export async function startTestApp() {
  const db = openDb(":memory:");
  const config = { encryptionKey: KEY, baseUrl: "http://test", dataDir: "./data", nodeEnv: "test", mockAssistable: true };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser);
  app.use(createToolApiRouter({ db, logger: noopLog }));
  app.use(createDashboardRouter({
    db, config, logger: noopLog,
    connectors: {
      csv: async (cfg) => parseCsvItems(cfg.csv_text),
      feed: async () => ({ rows: [] }), website: async () => ({ rows: [] }), database: async () => ({ rows: [] }),
    },
    makeClient: () => new AssistableClient({ apiKey: "x", mock: true, logger: noopLog }),
  }));
  const srv = app.listen(0);
  const t = { base: `http://127.0.0.1:${srv.address().port}`, db, srv };
  const res = await fetch(`${t.base}/signup`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "kb-bridge" }, body: JSON.stringify({ email: "owner@x.co", password: "longenough1" }) });
  t.ownerCookie = res.headers.get("set-cookie")?.split(";")[0];
  return t;
}
