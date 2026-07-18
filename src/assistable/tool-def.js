const MAX_FILTER_PARAMS = 6;

const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "source";

export function buildToolDefinition(source, columnMeta, { baseUrl, secret }) {
  const properties = {
    query: { type: "string", description: "What the customer is asking for, in plain words. Always provide it." },
  };
  const filterSummaries = [];
  const categoricals = columnMeta.filter((c) => c.kind === "categorical" && (c.distincts?.length ?? 0) >= 2);
  const numerics = columnMeta.filter((c) => c.kind === "numeric");
  let slots = MAX_FILTER_PARAMS;
  for (const c of categoricals) {
    if (slots <= 0) break;
    const shown = c.distincts.slice(0, 25);
    const more = c.distincts.length - shown.length;
    properties[c.name] = {
      type: "string",
      description: `Filter by ${c.name}. Common values: ${shown.join(", ")}${more > 0 ? ` (+${more} more accepted - pass whatever the customer says)` : ""}. Use "" if the customer did not mention it.`,
    };
    filterSummaries.push(c.name);
    slots--;
  }
  for (const c of numerics) {
    if (slots < 2) break;
    properties[`${c.name}_min`] = { type: "number", description: `Minimum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
    properties[`${c.name}_max`] = { type: "number", description: `Maximum ${c.name} (observed range ${c.min}-${c.max}). Use 0 if not mentioned.` };
    filterSummaries.push(`${c.name} range`);
    slots -= 2;
  }
  return {
    name: `live_data_${slug(source.name)}`.slice(0, 64),
    description: `Live ${source.name} lookup. ALWAYS call this before answering any question about ${source.name}. Returns current data plus a speech_hint you can read aloud. Never invent items; only state what this tool returns.${filterSummaries.length ? ` Filterable by: ${filterSummaries.join(", ")}.` : ""}`,
    tool_type: "FUNCTION",
    http_method: "POST",
    url: `${baseUrl}/api/tools/${source.id}/search`,
    headers: { "x-bridge-secret": secret },
    parameters: { type: "object", properties },
    required_params: [],
  };
}
