import * as cheerio from "cheerio";
import { safeFetch } from "../ssrf-guard.js";

// Price-table pages (scrap yards, rental rates, service menus): the data IS an
// HTML table. Parsing it into structured rows gives typed filters and exact
// answers - the website (prose) connector would flatten it into word soup.

const slugify = (s, i) =>
  (String(s).trim().toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || `col_${i + 1}`).slice(0, 40);

function parseTable($, tbl) {
  const $tbl = $(tbl);
  let headerCells = $tbl.find("thead tr").first().find("th,td");
  let bodyRows = $tbl.find("tbody tr");
  if (!headerCells.length) {
    headerCells = $tbl.find("tr").first().find("th,td");
    bodyRows = $tbl.find("tr").slice(1);
  } else if (!bodyRows.length) {
    bodyRows = $tbl.find("tr").slice(1);
  }
  const headers = [];
  headerCells.each((i, c) => {
    // Wikipedia-style header cells embed <style>/<script>/footnote markup whose
    // text would become the column name ("mw_parser_output_tooltip_...") and
    // get advertised to the LLM as a filter. Name from the visible text only.
    const $c = $(c).clone();
    $c.find("style,script,sup,small").remove();
    let name = slugify($c.text(), i);
    if (name.length >= 40) name = `col_${i + 1}`; // hit the slug cap = header was markup junk
    while (headers.includes(name)) name = `${name}_${i}`;
    headers.push(name);
  });
  if (headers.length < 2) return [];
  const rows = [];
  bodyRows.each((_, tr) => {
    const cells = $(tr).find("td,th");
    if (!cells.length) return;
    const row = {};
    cells.each((i, c) => { if (headers[i]) row[headers[i]] = $(c).text().replace(/\s+/g, " ").trim(); });
    if (Object.values(row).some((v) => v !== "")) rows.push(row);
  });
  return rows;
}

export async function fetchWebTableRows(config, { fetchImpl = safeFetch } = {}) {
  const res = await fetchImpl(config.url, {});
  if (res.status !== 200) {
    const e = new Error(`page returned HTTP ${res.status}`);
    e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw e;
  }
  const ct = (typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
  if (ct && !/html|text/i.test(ct)) {
    const e = new Error(`expected an HTML page, got ${ct}`); e.permanent = true; throw e;
  }
  const $ = cheerio.load(res.text);
  // Multiple tables on a page usually mean one data table + layout/nav junk:
  // take the largest by row count so the result is predictable.
  let best = [];
  $("table").each((_, tbl) => {
    const rows = parseTable($, tbl);
    if (rows.length > best.length) best = rows;
  });
  if (!best.length) {
    const e = new Error("no data table found on the page (needs a <table> with a header row and 2+ columns)");
    e.permanent = true; throw e;
  }
  return { rows: best };
}
