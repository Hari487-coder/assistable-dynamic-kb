import * as cheerio from "cheerio";
import { safeFetch } from "../ssrf-guard.js";

const CHUNK_TARGET = 700;

// Pack text into chunks that break on sentence boundaries near the target, so
// an answer is never severed mid-sentence and each chunk is a coherent unit
// BM25 can score. Blind character slicing (the old behaviour) split words and
// scattered one answer across two chunks.
function packSentences(text, target = CHUNK_TARGET) {
  // Protect decimals ("0.9%") and dotted abbreviations before splitting so a
  // full stop between digits is not mistaken for a sentence end, then restore.
  const DOT = ""; // private-use sentinel, never present in scraped text
  const guarded = text.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);
  const sentences = (guarded.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [guarded])
    .map((s) => s.replaceAll(DOT, "."));
  const out = [];
  let buf = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (buf && (buf.length + 1 + s.length) > target) { out.push(buf); buf = ""; }
    // A single sentence longer than the target still gets hard-split, but on a
    // word boundary rather than mid-word.
    if (s.length > target) {
      if (buf) { out.push(buf); buf = ""; }
      const words = s.split(/\s+/);
      let piece = "";
      for (const w of words) {
        if (piece && (piece.length + 1 + w.length) > target) { out.push(piece); piece = ""; }
        piece = piece ? `${piece} ${w}` : w;
      }
      if (piece) buf = piece;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function parseRobots(text) {
  const lines = String(text).split("\n").map((l) => l.trim());
  const dis = [];
  let applies = false;
  for (const l of lines) {
    const ua = l.match(/^user-agent:\s*(.+)$/i);
    if (ua) { applies = ua[1].trim() === "*"; continue; }
    const d = l.match(/^disallow:\s*(.*)$/i);
    if (applies && d) dis.push(d[1].trim());
  }
  return dis;
}

function pageChunks(url, html) {
  const $ = cheerio.load(html);
  $("script,style,nav,footer,header,noscript,iframe").remove();
  const chunks = [];
  let heading = $("title").text().trim() || url;
  let buf = [];
  const flush = () => {
    const content = buf.join(" ").replace(/\s+/g, " ").trim();
    if (content) {
      for (const piece of packSentences(content)) {
        chunks.push({ page_url: url, heading, content: piece });
      }
    }
    buf = [];
  };
  $("body").find("h1,h2,h3,p,li,td,th").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (["h1", "h2", "h3"].includes(tag)) { flush(); heading = text; }
    else buf.push(text);
  });
  flush();
  return chunks;
}

export async function crawlSiteItems(config, { fetchImpl = safeFetch, delayMs } = {}) {
  const { url, maxPages = 50, maxDepth = 3 } = config;
  const origin = new URL(url).origin;
  let disallow = [];
  try {
    const robots = await fetchImpl(`${origin}/robots.txt`, {});
    if (robots.status === 200) disallow = parseRobots(robots.text);
  } catch { /* no robots -> allowed */ }
  const blocked = (path) => disallow.some((d) => d !== "" && path.startsWith(d));
  if (blocked(new URL(url).pathname) || disallow.includes("/")) {
    const e = new Error("crawl blocked by robots.txt"); e.permanent = true; throw e;
  }
  const seen = new Set();
  const queue = [{ href: url, depth: 0 }];
  const rows = [];
  while (queue.length && seen.size < maxPages) {
    const { href, depth } = queue.shift();
    const norm = href.split("#")[0];
    if (seen.has(norm) || blocked(new URL(norm).pathname)) continue;
    seen.add(norm);
    let res;
    try { res = await fetchImpl(norm, {}); } catch { continue; }
    if (res.status !== 200) continue;
    // Same-origin links can point at PDFs/images; parsing binary as HTML
    // yields junk chunks. Trust the content-type when the server sends one.
    const ct = (typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
    if (ct && !/html|text/i.test(ct)) continue;
    rows.push(...pageChunks(norm, res.text));
    if (depth < maxDepth) {
      const $ = cheerio.load(res.text);
      $("a[href]").each((_, a) => {
        try {
          const next = new URL($(a).attr("href"), norm);
          if (next.origin === origin) queue.push({ href: next.href, depth: depth + 1 });
        } catch { /* bad href */ }
      });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!rows.length) { const e = new Error("no content extracted from site"); e.permanent = true; throw e; }
  return { rows };
}
