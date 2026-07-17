import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { openDb } from "./db.js";
import { cookieParser } from "./auth.js";
import { createToolApiRouter } from "./routes/tool-api.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { startScheduler } from "./sync/engine.js";
import { AssistableClient } from "./assistable/client.js";
import { fetchFeedItems } from "./connectors/feed.js";
import { parseCsvItems } from "./connectors/csv.js";
import { crawlSiteItems } from "./connectors/website.js";
import { fetchDbItems } from "./connectors/database.js";
import * as pages from "./views/pages.js";

export const defaultConnectors = {
  feed: (cfg) => fetchFeedItems(cfg),
  csv: async (cfg) => parseCsvItems(cfg.csv_text),
  website: (cfg) => crawlSiteItems(cfg, { delayMs: 300 }),
  database: (cfg) => fetchDbItems(cfg),
};

export function buildApp(deps) {
  const { db, config, logger } = deps;
  const connectors = deps.connectors ?? defaultConnectors;
  const makeClient = deps.makeClient ?? ((apiKey) =>
    new AssistableClient({ apiKey, base: config.assistableApiBase, mock: config.mockAssistable, logger }));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    xFrameOptions: { action: "deny" },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // views use inline handlers; helmet defaults this to 'none'
      frameAncestors: ["'none'"],
    }},
  }));
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser);
  app.use(createToolApiRouter({ db, logger }));
  app.use(createDashboardRouter({ db, config, logger, connectors, makeClient }));
  app.use((_req, res) => res.status(404).send(pages.layoutPage("Not found", "<p>Page not found.</p>")));
  app.use((err, _req, res, _next) => {
    logger.error("unhandled", { error: String(err?.message || err) });
    res.status(500).json({ ok: false, error: "internal error" });
  });
  return app;
}

const isMain = process.argv[1] && /server\.js$/.test(process.argv[1]);
if (isMain) {
  // Minimal .env loader (no dotenv dep): KEY=VALUE lines, # comments stripped.
  try {
    for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*)/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch { /* no .env — rely on real env vars */ }
  const config = loadConfig(process.env, { autoKey: true });
  const logger = createLogger();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, "kb-bridge.db"));
  const app = buildApp({ db, config, logger, connectors: defaultConnectors });
  const scheduler = startScheduler({ db, config, logger, connectors: defaultConnectors });
  const server = app.listen(config.port, () => logger.info("kb-bridge listening", { port: config.port, mock: config.mockAssistable }));
  const shutdown = () => {
    logger.info("shutting down");
    scheduler.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
