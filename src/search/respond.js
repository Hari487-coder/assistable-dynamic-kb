const SALIENT_MAX = 8;

function trimItem(structured) {
  const entries = Object.entries(structured).filter(([, v]) => v !== null && v !== "").slice(0, SALIENT_MAX);
  return Object.fromEntries(entries);
}

// Currency comes from the column name when the business tells us ("price_per
// _kg_gbp" -> £). Guessing $ for a UK scrap dealer is worse than useless.
const CURRENCIES = [[/gbp|pound|sterling/i, "£"], [/eur/i, "€"], [/inr|rupee/i, "₹"], [/aud/i, "A$"], [/cad/i, "CA$"]];
const MONEY_COL = /price|cost|rate|amount|fee|value|per_kg|per_lb|per_tonne/i;

function money(n, key = "") {
  if (typeof n !== "number") return String(n);
  const symbol = CURRENCIES.find(([re]) => re.test(key))?.[1] ?? "$";
  // Unit prices read as money ("£4.00"), big-ticket prices read as whole
  // numbers ("$28,500") - saying "twenty-eight thousand five hundred point
  // zero zero" on a call is worse than useless.
  const opts = n < 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 };
  return `${symbol}${n.toLocaleString("en-US", opts)}`;
}

/**
 * Name one result the way a person would say it. Data-driven, not
 * domain-specific: the ingest-time title plus the most money-like number.
 * (This used to read `item.year/make/model`, so every non-car business heard
 * the literal fallback "a match".)
 */
function itemPhrase(item) {
  const label = item.title
    || Object.entries(item).find(([, v]) => typeof v === "string" && v.trim())?.[1]
    || "one option";
  const priced = Object.entries(item).find(([k, v]) => typeof v === "number" && MONEY_COL.test(k));
  return priced ? `${label} at ${money(priced[1], priced[0])}` : String(label);
}

function speechHint({ resultCount, items, alternatives, relaxations }) {
  if (resultCount > 0) {
    if (resultCount === 1) return `Yes - we have one match: ${itemPhrase(items[0])}.`;
    // Voice callers decide fastest hearing the top two options, not just one.
    const second = items[1] ? `; also ${itemPhrase(items[1])}` : "";
    return `Yes - ${resultCount} matches. Best fit: ${itemPhrase(items[0])}${second}.`;
  }
  if (alternatives.length) {
    return `No exact match, but the closest we have is ${itemPhrase(alternatives[0])}. ${relaxations[0] || ""}`.trim();
  }
  return "Nothing in our current live data matches that. Offer to check related options or take a message.";
}

export function buildToolResponse({ source, structured, textResult, args, tookMs }) {
  const base = {
    ok: true,
    as_of: source.last_sync_at,
    data_freshness: source.last_sync_at && Date.now() - Date.parse(source.last_sync_at) < 2 * source.schedule_minutes * 60_000 ? "fresh" : "stale",
  };
  if (textResult) {
    const weak = textResult.matchQuality === "weak";
    return {
      ...base,
      result_count: textResult.resultCount,
      answerable: textResult.resultCount > 0 && !weak,
      confidence: textResult.resultCount === 0 ? "none" : weak ? "low" : "high",
      items: textResult.items,
      speech_hint: textResult.resultCount
        ? `${weak ? "This might be related: " : "Found it: "}${textResult.items[0].snippet.slice(0, 140)}`
        : "I couldn't find that on the live site data. Offer to take a message.",
      ...(weak ? { guidance: "Only a partial keyword match was found. Present it as possibly related, not as a definitive answer." } : {}),
      took_ms: tookMs,
    };
  }
  if (structured.browse) {
    const askAbout = (structured.browseColumns || []).join(", ") || "what you're looking for";
    return {
      ...base,
      result_count: structured.resultCount,
      browse: true,
      items: structured.items.slice(0, 3).map((i) => ({ title: i.title, ...trimItem(i.structured) })),
      speech_hint: `We have ${structured.resultCount} option${structured.resultCount === 1 ? "" : "s"} right now. Ask the customer what they're looking for - you can filter by ${askAbout}.`,
      guidance: "The caller hasn't narrowed anything down yet. Ask a clarifying question using the filterable fields; don't read the whole list.",
      took_ms: tookMs,
    };
  }
  const items = structured.resultCount ? structured.items.map((i) => ({ title: i.title, ...trimItem(i.structured) })) : [];
  const alternatives = structured.alternatives.map((i) => ({ title: i.title, ...trimItem(i.structured) }));
  const out = {
    ...base,
    result_count: structured.resultCount,
    applied_filters: structured.appliedFilters,
    relaxations: structured.relaxations,
    items,
    ...(alternatives.length ? { close_alternatives: alternatives } : {}),
    // Speak from the DISPLAY items - they carry the title. Passing the raw
    // structured payload was why every phrase collapsed to "a match".
    speech_hint: speechHint({
      resultCount: structured.resultCount, items, alternatives,
      relaxations: structured.relaxations,
    }),
    guidance: "Data is live from the business's own system. If data_freshness is 'stale', say the info is from the last update. Never invent items not listed.",
    took_ms: tookMs,
  };
  while (JSON.stringify(out).length > 1600 && out.items.length > 1) out.items.pop();
  return out;
}
