const SALIENT_MAX = 8;

function trimItem(structured) {
  const entries = Object.entries(structured).filter(([, v]) => v !== null && v !== "").slice(0, SALIENT_MAX);
  return Object.fromEntries(entries);
}

function money(n) { return typeof n === "number" && n >= 1000 ? `$${n.toLocaleString("en-US")}` : String(n); }

function itemPhrase(item) {
  const desc = [item.year, item.make, item.model].filter(Boolean).join(" ") || item.title || "match";
  return `a ${desc}${item.price ? ` at ${money(item.price)}` : ""}`;
}

function speechHint({ resultCount, items, alternatives, relaxations }) {
  if (resultCount > 0) {
    if (resultCount === 1) return `Yes - we have one match: ${itemPhrase(items[0])}.`;
    // Voice callers decide fastest hearing the top two options, not just one.
    const second = items[1] ? `; also ${itemPhrase(items[1])}` : "";
    return `Yes - ${resultCount} matches. Best fit: ${itemPhrase(items[0])}${second}.`;
  }
  if (alternatives.length) {
    const a = alternatives[0];
    const desc = [a.year, a.make, a.model].filter(Boolean).join(" ") || a.title || "option";
    return `No exact match, but the closest we have is a ${desc}${a.price ? ` at ${money(a.price)}` : ""}. ${relaxations[0] || ""}`.trim();
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
  const items = structured.resultCount ? structured.items.map((i) => ({ title: i.title, ...trimItem(i.structured) })) : [];
  const alternatives = structured.alternatives.map((i) => ({ title: i.title, ...trimItem(i.structured) }));
  const out = {
    ...base,
    result_count: structured.resultCount,
    applied_filters: structured.appliedFilters,
    relaxations: structured.relaxations,
    items,
    ...(alternatives.length ? { close_alternatives: alternatives } : {}),
    speech_hint: speechHint({
      resultCount: structured.resultCount,
      items: structured.items.map((i) => i.structured),
      alternatives: structured.alternatives.map((i) => i.structured),
      relaxations: structured.relaxations,
    }),
    guidance: "Data is live from the business's own system. If data_freshness is 'stale', say the info is from the last update. Never invent items not listed.",
    took_ms: tookMs,
  };
  while (JSON.stringify(out).length > 1600 && out.items.length > 1) out.items.pop();
  return out;
}
