import { findGeoCols } from "../search/geo.js";

const MAX_FILTER_PARAMS = 6;

const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "source";

/**
 * Parameter names go straight into the LLM tool schema, and column names come
 * from customer spreadsheets - "Price per kg (£)", "Grade / Type". An invalid
 * name makes the provider reject the WHOLE request (400 Invalid
 * 'tools[N].function...'), which takes every chat for that assistant dark, not
 * just this tool. Sanitize to the union of what OpenAI/Anthropic accept.
 */
export const paramName = (column) =>
  String(column).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 56) || "field";

export function buildToolDefinition(source, columnMeta, { baseUrl, secret }) {
  const properties = {
    query: { type: "string", description: "What the customer is asking for, in plain words. Always provide it." },
  };
  const filterSummaries = [];
  // Rows with coordinates unlock "near me"-style search. These ride outside
  // the 6-slot budget: location is the marketplace question, not one filter
  // among many.
  if (findGeoCols(columnMeta)) {
    properties.near = { type: "string", description: `The customer's location: a UK postcode (full or partial, e.g. "CR4 4HX" or "SW19") or a town/city name. Use "" if they did not say where they are.` };
    properties.radius_miles = { type: "number", description: "How far the customer will travel, in miles. Use 25 if they did not say." };
    filterSummaries.push("distance from a postcode or town (near + radius_miles)");
  }
  // A column of long prose (a description, a spec paragraph) is technically
  // categorical when every row repeats one of N blurbs, but it is useless as a
  // filter: nobody says a whole sentence to narrow a search, and offering it
  // burns a slot a real filter needs. Keep label-sized values only.
  const isLabelSized = (c) =>
    c.distincts.reduce((sum, v) => sum + String(v).length, 0) / c.distincts.length <= 25;
  const categoricals = columnMeta.filter(
    (c) => c.kind === "categorical" && (c.distincts?.length ?? 0) >= 2 && isLabelSized(c)
  );
  const numerics = columnMeta.filter((c) => c.kind === "numeric");
  // Slots are scarce (6) and first-come order used to be arbitrary: on a table
  // with a few categoricals plus year, the PRICE range - the filter customers
  // actually ask by - fell off the end. Rank by usefulness instead: money-like
  // ranges first, plain label filters next, other ranges, and date-like
  // categoricals last (nobody narrows a call by "12 May 2022").
  const MONEYISH = /price|cost|rate|amount|fee|value|msrp|per_kg|per_lb|per_tonne|total/i;
  const DATEISH = /date|updated|created|modified|timestamp|_at$/i;
  const requests = [
    ...numerics.filter((c) => MONEYISH.test(c.name)).map((c) => ({ c, range: true })),
    ...categoricals.filter((c) => !DATEISH.test(c.name)).map((c) => ({ c, range: false })),
    ...numerics.filter((c) => !MONEYISH.test(c.name)).map((c) => ({ c, range: true })),
    ...categoricals.filter((c) => DATEISH.test(c.name)).map((c) => ({ c, range: false })),
  ];
  let slots = MAX_FILTER_PARAMS;
  for (const { c, range } of requests) {
    const cost = range ? 2 : 1;
    if (slots < cost) continue; // a 1-slot label can still fit after a range didn't
    if (range) {
      properties[`${paramName(c.name)}_min`] = { type: "number", description: `Minimum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
      properties[`${paramName(c.name)}_max`] = { type: "number", description: `Maximum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
      filterSummaries.push(`${c.name} range`);
    } else {
      const shown = c.distincts.slice(0, 25);
      const more = c.distincts.length - shown.length;
      properties[paramName(c.name)] = {
        type: "string",
        description: `Filter by ${c.name}. Common values: ${shown.join(", ")}${more > 0 ? ` (+${more} more accepted - pass whatever the customer says)` : ""}. Use "" if the customer did not mention it.`,
      };
      filterSummaries.push(c.name);
    }
    slots -= cost;
  }
  return {
    name: `live_data_${slug(source.name)}`.slice(0, 64),
    description: `Live ${source.name} lookup. ALWAYS call this before answering any question about ${source.name}. Returns current data plus a speech_hint you can read aloud. Never invent items; only state what this tool returns.${filterSummaries.length ? ` Filterable by: ${filterSummaries.join(", ")}.` : ""}`,
    tool_type: "FUNCTION",
    // Assistable's dashboard only lets you edit tools with category "custom"
    // (v2 tools PATCH filters on it) - without this the owner sees "Custom
    // tool not found or cannot be modified" on a tool we created for them.
    category: "custom",
    http_method: "POST",
    url: `${baseUrl}/api/tools/${source.id}/search`,
    headers: { "x-bridge-secret": secret },
    parameters: { type: "object", properties },
    required_params: [],
  };
}
