import * as cheerio from "cheerio";
import { safeFetch } from "../ssrf-guard.js";

const CHUNK_TARGET = 1500;

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
      for (let i = 0; i < content.length; i += CHUNK_TARGET) {
        chunks.push({ page_url: url, heading, content: content.slice(i, i + CHUNK_TARGET) });
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
