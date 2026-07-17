import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
// Agent and fetch MUST come from the same undici instance — passing the npm
// package's Agent to Node's built-in fetch is silently ignored/hangs.
import { Agent, fetch as undiciFetch } from "undici";

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip) {
  return ip.split(".").reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n);
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >> BigInt(32 - bits)) === (v4ToInt(base) >> BigInt(32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
    return false;
  }
  return true; // unparseable -> treat as unsafe
}

const DEFAULT_PORTS = [80, 443, 8080, 8443];

export async function assertPublicHttpUrl(urlStr, { lookupFn, allowedPorts = DEFAULT_PORTS, allowPrivateForTest = false } = {}) {
  let url;
  try { url = new URL(urlStr); } catch { const e = new Error("SSRF blocked: invalid URL"); e.code = "SSRF_BLOCKED"; e.permanent = true; throw e; }
  if (!["http:", "https:"].includes(url.protocol)) {
    const e = new Error("SSRF blocked: scheme not allowed"); e.code = "SSRF_BLOCKED"; e.permanent = true; throw e;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!allowedPorts.includes(port)) {
    const e = new Error(`SSRF blocked: port ${port} not allowed`); e.code = "SSRF_BLOCKED"; e.permanent = true; throw e;
  }
  const resolve = lookupFn || ((h) => dnsLookup(h, { all: true }));
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await resolve(url.hostname);
  if (!allowPrivateForTest && addrs.some((a) => isPrivateIp(a.address))) {
    const e = new Error("SSRF blocked: resolves to private address"); e.code = "SSRF_BLOCKED"; e.permanent = true; throw e;
  }
  return url;
}

export async function safeFetch(urlStr, opts = {}) {
  const { timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024, maxRedirects = 4, headers = {} } = opts;
  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current, opts);
    // Re-validate at connect time too (anti DNS-rebinding).
    const agent = new Agent({
      connect: {
        lookup: (hostname, o, cb) => {
          const resolve = opts.lookupFn || ((h) => dnsLookup(h, { all: true }));
          resolve(hostname).then((addrs) => {
            const bad = !opts.allowPrivateForTest && addrs.some((a) => isPrivateIp(a.address));
            if (bad || addrs.length === 0) return cb(new Error("SSRF blocked at connect"));
            const fam = (a) => a.family || (net.isIPv6(a.address) ? 6 : 4);
            if (o?.all) return cb(null, addrs.map((a) => ({ address: a.address, family: fam(a) })));
            cb(null, addrs[0].address, fam(addrs[0]));
          }, cb);
        },
      },
    });
    let res;
    try {
      res = await undiciFetch(current, {
        headers, redirect: "manual", dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("redirect without location");
        current = new URL(loc, current).href;
        continue;
      }
      const reader = res.body?.getReader();
      const chunks = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel(); throw new Error(`response size exceeds ${maxBytes} bytes`); }
          chunks.push(value);
        }
      }
      return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
    } finally {
      agent.close().catch(() => {});
    }
  }
  throw new Error("too many redirects");
}
