import { parseNumericLike } from "../ingest/normalize.js";

// Deterministic query-understanding safety net. Voice LLMs frequently pass the
// caller's words without extracting typed filters; these rules recover the
// constraints that matter most (price/mileage bounds, year, sort order) from
// the raw question so accuracy never depends on the model having a good day.

const COL_MATCHERS = {
  price: /price|cost|msrp|amount|total/i,
  mileage: /mileage|miles|odometer|km/i,
  year: /^year$|model_?year/i,
};

function findCol(columns, kind) {
  return columns.find((c) => c.kind === "numeric" && COL_MATCHERS[kind].test(c.name))?.name ?? null;
}

const MAX_RE = /(?:under|below|less than|at most|up to|max(?:imum)?)\s*\$?\s*([\d][\d,.]*)\s*(k|thousand|grand)?\s*(miles|mi\b|km)?/i;
const MIN_RE = /(?:over|above|more than|at least|min(?:imum)?)\s*\$?\s*([\d][\d,.]*)\s*(k|thousand|grand)?\s*(miles|mi\b|km)?/i;
const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

const SORTS = [
  { re: /cheapest|lowest price|least expensive|most affordable|low to high/i, colKind: "price", dir: "asc" },
  { re: /most expensive|priciest|high to low/i, colKind: "price", dir: "desc" },
  { re: /newest|latest|most recent/i, colKind: "year", dir: "desc" },
  { re: /\boldest\b/i, colKind: "year", dir: "asc" },
  { re: /lowest (?:miles|mileage)|fewest miles/i, colKind: "mileage", dir: "asc" },
];

function boundFilter(query, columns, re, op) {
  const m = query.match(re);
  if (!m) return null;
  const value = parseNumericLike(m[1] + (m[2] ? "k" : ""));
  if (value === null) return null;
  const col = m[3] ? findCol(columns, "mileage") : findCol(columns, "price");
  return col ? { col, op, value, note: `applied "${m[0].trim()}" from the question` } : null;
}

/**
 * deriveIntent(query, columns) ->
 *   { filters: [{col, op, value, note}], sort: {col, dir}|null, cleanedQuery }
 * Only proposes filters; the caller must skip any column the LLM already
 * filtered. cleanedQuery has consumed phrases removed so the FTS leg doesn't
 * re-match filter words ("under 30 thousand") as content tokens.
 */
export function deriveIntent(query, columns) {
  let q = String(query || "");
  const filters = [];
  for (const [re, op] of [[MAX_RE, "max"], [MIN_RE, "min"]]) {
    const m = q.match(re);
    const f = boundFilter(q, columns, re, op);
    if (f) { filters.push(f); q = q.replace(m[0], " "); }
  }
  const yearCol = findCol(columns, "year");
  const ym = q.match(YEAR_RE);
  if (yearCol && ym) {
    filters.push({ col: yearCol, op: "eq", value: Number(ym[1]), note: `matched year ${ym[1]} from the question` });
    q = q.replace(ym[0], " ");
  }
  let sort = null;
  for (const s of SORTS) {
    if (s.re.test(q)) {
      const col = findCol(columns, s.colKind);
      if (col) { sort = { col, dir: s.dir }; q = q.replace(s.re, " "); break; }
    }
  }
  // Qualitative terms resolve against THIS business's own data distribution
  // (quartiles from column stats) - "cheap" at a Kia lot and a Porsche dealer
  // mean different numbers, and both are right. Runs after sort-stripping so
  // "cheapest" (a sort) never double-fires as "cheap" (a filter).
  for (const rule of QUALITATIVE) {
    const m = q.match(rule.re);
    if (!m) continue;
    const colName = findCol(columns, rule.colKind);
    const col = columns.find((c) => c.name === colName);
    const bound = col?.[rule.q];
    if (bound === undefined || filters.some((f) => f.col === colName && f.op === rule.op)) continue;
    filters.push({
      col: colName, op: rule.op, value: bound,
      note: `interpreted "${m[0].trim()}" as ${colName} ${rule.op === "max" ? "up to" : "from"} ${bound} (based on your data's range)`,
    });
    q = q.replace(m[0], " ");
  }
  return { filters, sort, cleanedQuery: q };
}

const QUALITATIVE = [
  { re: /\b(?:cheap(?:er)?|affordable|inexpensive|budget(?:[- ]friendly)?|low[- ]cost|entry[- ]level|starter)\b/i, colKind: "price", op: "max", q: "p25" },
  { re: /\b(?:expensive|premium|high[- ]end|luxury|top[- ]of[- ]the[- ]line)\b/i, colKind: "price", op: "min", q: "p75" },
  { re: /\b(?:low|fewer|less)[- ](?:miles|mileage)\b|\blow[- ]mile\b/i, colKind: "mileage", op: "max", q: "p25" },
  { re: /\bhigh[- ](?:miles|mileage)\b/i, colKind: "mileage", op: "min", q: "p75" },
  { re: /\b(?:newer|late[- ]model|recent[- ]model)\b/i, colKind: "year", op: "min", q: "p75" },
  { re: /\b(?:older|early[- ]model)\b/i, colKind: "year", op: "max", q: "p25" },
];
