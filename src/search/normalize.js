export const ALIASES = new Map(Object.entries({
  chevy: "chevrolet", vw: "volkswagen", benz: "mercedes-benz", "mercedes benz": "mercedes-benz",
  beemer: "bmw", bimmer: "bmw", subie: "subaru", lambo: "lamborghini", vette: "corvette",
}));

export const normalizeToken = (s) => String(s ?? "").toLowerCase().trim().replace(/[^\w\s-]/g, "");

// Words that carry no retrieval signal in a spoken question. Filtering them
// before FTS keeps matches precise AND fast (every extra term is a doclist
// merge over the whole index).
const STOPWORDS = new Set(("a an the any some do does you your yours have has is are was be been what whats which who how many much " +
  "i we me my our us it its in on of for with and or to from at by please show me find got there their this that these those can could would like want need").split(" "));

/** Query text -> FTS-ready tokens: lowercased, punctuation-free, stopword-filtered, max 6. */
export function tokensFor(query) {
  return String(query || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t)).slice(0, 6);
}

// Deterministic synonym groups for the vocabulary gap embeddings usually cover:
// a caller says "fix", the site says "repair". Each group becomes an OR-clause
// inside the AND match, so precision survives while recall widens.
const SYNONYM_GROUPS = [
  ["fix", "repair", "service"],
  ["price", "prices", "pricing", "cost", "costs", "rate", "rates", "fee", "fees", "charge"],
  ["hours", "open", "opening", "closed", "schedule"],
  ["phone", "call", "contact", "reach"],
  ["warranty", "guarantee", "guaranteed"],
  ["return", "returns", "refund", "refunds", "exchange"],
  ["appointment", "appointments", "booking", "book", "reserve"],
  ["delivery", "deliver", "shipping", "ship", "shipped"],
  ["cancel", "cancellation", "cancelling"],
  ["payment", "pay", "financing", "finance", "installments"],
  ["cheap", "cheapest", "affordable", "budget"],
  ["buy", "purchase", "sell", "selling"],
  ["stock", "available", "availability", "inventory"],
  // Small-business FAQ vocabulary: the questions a website source actually gets
  // asked on a call. "same-day" vs "on the spot", "quote" vs "estimate", etc.
  ["today", "same-day", "sameday", "immediately", "now", "spot", "walk-in", "walkin"],
  ["quote", "quotes", "estimate", "estimates", "pricing"],
  ["location", "address", "where", "directions", "located", "find"],
  ["parking", "park", "lot"],
  ["deposit", "downpayment", "upfront"],
  ["cash", "card", "credit", "debit", "paypal"],
  ["pickup", "pick-up", "collection", "collect"],
  ["hours", "days", "weekend", "weekends", "sunday", "saturday", "holiday"],
  ["insured", "insurance", "insure", "licensed", "certified", "bonded"],
  ["discount", "deal", "deals", "offer", "offers", "promotion", "special"],
  ["minimum", "min", "smallest", "least"],
  ["contact", "email", "message", "text", "whatsapp"],
];
const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group);

/** A token's OR-expansion group (itself included), for FTS match construction. */
export function expandToken(token) {
  return SYNONYMS.get(token) ?? [token];
}

export function editDistance(a, b) {
  a = normalizeToken(a); b = normalizeToken(b);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function resolveCategorical(value, distincts = []) {
  const v = String(value ?? "").trim();
  if (!v) return { value: null, method: null };
  const exact = distincts.find((d) => d === v);
  if (exact) return { value: exact, method: "exact" };
  const ci = distincts.find((d) => d.toLowerCase() === v.toLowerCase());
  if (ci) return { value: ci, method: "ci" };
  const alias = ALIASES.get(normalizeToken(v));
  if (alias) {
    const hit = distincts.find((d) => d.toLowerCase() === alias);
    if (hit) return { value: hit, method: "alias" };
  }
  let best = null, bestDist = 3;
  for (const d of distincts) {
    const dist = editDistance(v, d);
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  if (best && bestDist <= 2) return { value: best, method: "fuzzy" };
  return { value: null, method: null };
}
