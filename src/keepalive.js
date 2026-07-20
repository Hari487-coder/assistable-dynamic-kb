// Keep a free-tier host awake.
//
// Render's free web services spin an instance down after ~15 minutes without
// inbound traffic. The next visitor then lands during a 30-60s cold boot and
// Render's edge returns a bare "Not Found" (x-render-routing: no-server) until
// the app is listening again — which is why a shared signup link "loads on
// refresh".
//
// A request to our OWN public URL is inbound traffic to the service, so pinging
// /healthz every 10 minutes (comfortably inside the 15-minute window) keeps the
// instance warm with zero setup for whoever deployed it. It runs only where it
// helps: on Render (RENDER is set) with an https base URL. KEEP_AWAKE=1 forces
// it on for any https host (e.g. another free PaaS); KEEP_AWAKE=0 turns it off.
//
// This is a warmth aid, not a durability one: the free tier still wipes its disk
// on redeploy. For guaranteed always-on, use the Oracle VM path in the docs.

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 min < Render's 15-min idle window

/** Pure predicate so the enable/disable rule is unit-testable in isolation. */
export function shouldKeepAlive(env, baseUrl) {
  const isPublicHttps = /^https:\/\//i.test(baseUrl || "");
  if (env.KEEP_AWAKE === "0") return false;
  if (env.KEEP_AWAKE === "1") return isPublicHttps;
  return Boolean(env.RENDER) && isPublicHttps;
}

export function startKeepAlive({
  config,
  logger,
  env = process.env,
  fetchImpl = globalThis.fetch,
  intervalMs = PING_INTERVAL_MS,
} = {}) {
  if (!shouldKeepAlive(env, config.baseUrl)) return { stop() {} };

  const target = `${config.baseUrl}/healthz`;
  const ping = async () => {
    try {
      // Self-request; a slow reply still counts as traffic, so a short cap is fine.
      await fetchImpl(target, { method: "GET", signal: AbortSignal.timeout(8000) });
    } catch (err) {
      logger.warn("keep-alive ping failed", { target, error: String(err?.message || err) });
    }
  };

  const timer = setInterval(ping, intervalMs);
  timer.unref?.(); // never hold the process open on our account
  logger.info("keep-alive on", { target, everyMinutes: Math.round(intervalMs / 60000) });
  return { stop() { clearInterval(timer); } };
}
