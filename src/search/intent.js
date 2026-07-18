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
 * deriveIntent(query, columns) -> { filters: [{col, op, value, note}], sort: {col, dir}|null }
 * Only proposes filters; the caller must skip any column the LLM already filtered.
 */
export function deriveIntent(query, columns) {
  const q = String(query || "");
  const filters = [];
  for (const [re, op] of [[MAX_RE, "max"], [MIN_RE, "min"]]) {
    const f = boundFilter(q, columns, re, op);
    if (f) filters.push(f);
  }
  const yearCol = findCol(columns, "year");
  const ym = q.match(YEAR_RE);
  if (yearCol && ym) {
    filters.push({ col: yearCol, op: "eq", value: Number(ym[1]), note: `matched year ${ym[1]} from the question` });
  }
  let sort = null;
  for (const s of SORTS) {
    if (s.re.test(q)) {
      const col = findCol(columns, s.colKind);
      if (col) { sort = { col, dir: s.dir }; break; }
    }
  }
  return { filters, sort };
}
