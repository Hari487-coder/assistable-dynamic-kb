// "No price yet" is a real, common state on a marketplace: yards that haven't
// published today, or grades they don't buy. These markers mean MISSING, not
// text - counting them as parse failures would demote a whole price column to
// text the moment a tenth of the rows said "POA".
export const NO_VALUE_RE = /^(n\/?a|na|null|none|nil|nan|-{1,3}|—|–|\?|tbc|tba|tbd|poa|p\.?o\.?a\.?|por|ask|call|call us|call for price|phone|phone for price|price on request|on request|request|enquire|enquiry|inquire|contact|contact us|no price|not set|not listed|coming soon)$/i;

export function parseNumericLike(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || NO_VALUE_RE.test(s)) return null;
  // "£7.20", "US$143,000,000", "GBP 7.20": one un-parsed currency style on a
  // price column demotes the whole column to text (no filters, no quartiles),
  // so strip code/symbol prefixes before deciding numeric-ness.
  // "a" last so the two-letter codes win the alternation: A$ is the form AUD
  // actually ships in, and detectCurrency already claims to recognise it.
  s = s.replace(/^(usd|gbp|eur|inr|aud|cad|nzd)\s*(?=[\d$£€₹])|^(us|au|ca|nz|a)(?=\$)/, "");
  let mult = 1;
  if (/^[$£€₹]?[\d,.]+\s*k$/.test(s)) { mult = 1000; s = s.replace(/k$/, ""); }
  s = s.replace(/[$£€₹,\s]/g, "").replace(/(km|mi|miles|kms)$/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * mult;
}

// Filterable-categorical ceiling. A 1,000-row inventory legitimately has 60+
// models; treating those as free text would silently drop exact filtering —
// the same failure the static KB has. IDs (VINs, SKUs) stay text because their
// distinct-ratio is ~1.
const MAX_DISTINCTS = 500;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;
const META_COL = /date|updated|created|modified|timestamp|_at$/i;
// Codes, contact strings and flags are never how a person names a row out
// loud: "Sullivans Metal Recycling SE25 6NX" spends the title on a postcode
// and pushes out the grade the caller actually asked about.
const CODE_COL = /(^|_)(postcode|postal|zip|eircode|lat|lng|lon|longitude|latitude|phone|mobile|tel|whatsapp|email|url|website|link|slug|active|verified|status|enabled|id)(_|$)/i;

// Which currency the raw values carried, remembered BEFORE the numeric parse
// strips it. Without this, "£7.20" ingests fine but gets spoken as "$7.20" -
// worse than useless for a UK business. Most-specific prefixes first.
const CURRENCY_PREFIXES = [
  [/^(?:£|gbp\b)/i, "£"], [/^(?:€|eur\b)/i, "€"], [/^(?:₹|inr\b)/i, "₹"],
  [/^(?:a\$|aud\b)/i, "A$"], [/^(?:ca\$|cad\b)/i, "CA$"], [/^(?:us\$|\$|usd\b)/i, "$"],
];
function detectCurrency(vals) {
  const counts = new Map();
  for (const v of vals) {
    const hit = CURRENCY_PREFIXES.find(([re]) => re.test(String(v).trim()));
    if (hit) counts.set(hit[1], (counts.get(hit[1]) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= vals.length * 0.5 ? top[0] : null;
}

// Spoken unit, from the column's own name. "£7.20" alone is dangerously
// ambiguous in scrap and produce trades - per kilo or per tonne changes the
// answer by a factor of a thousand. Words, not symbols, because this is read
// aloud: "per kilo" survives text-to-speech, "per kg" does not always.
const UNITS = [
  [/per[_\s-]?(?:kg|kilo(?:gram)?s?)\b|_kg(?:_|$)|\bkg\b/i, "per kilo"],
  [/per[_\s-]?(?:lb|lbs|pounds?)\b|_lb(?:_|$)/i, "per pound"],
  [/per[_\s-]?(?:tonne|ton|mt)\b|_tonne(?:_|$)/i, "per tonne"],
  [/per[_\s-]?(?:gram|g)\b/i, "per gram"],
  [/per[_\s-]?(?:item|unit|piece|each)\b/i, "each"],
];
const detectUnit = (name) => UNITS.find(([re]) => re.test(String(name)))?.[1] ?? null;

/**
 * "£8.20 – £8.70", "9 to 10", "6.00-8.50" -> {from, to}.
 * Marketplaces quote BANDS, not points: every price on a scrap index is the
 * yard's margin range. Without this the cell fails the numeric parse and the
 * column loses filtering, sorting and quartiles entirely.
 * Both sides must parse as numbers, so dates ("2026-07-22") and negatives
 * ("-5") are not mistaken for ranges.
 */
export function parseRangeLike(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(.*?[\d)])\s*(?:–|—|-|\bto\b)\s*([^\s].*)$/i);
  if (!m) return null;
  const from = parseNumericLike(m[1]);
  const to = parseNumericLike(m[2]);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

/** A value's numeric span: a range as-is, a plain number as a zero-width span. */
function spanOf(v) {
  const r = parseRangeLike(v);
  if (r) return r;
  const n = parseNumericLike(v);
  return n === null ? null : { from: n, to: n };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function inferColumnMeta(rows) {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  return names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const spans = vals.map(spanOf).filter(Boolean);
    // "POA"/"call for price" rows are missing prices, not evidence that the
    // column is text - so they leave the denominator rather than voting on it.
    const stated = vals.length - vals.filter((v) => NO_VALUE_RE.test(String(v).trim())).length;
    if (stated > 0 && spans.length >= stated * 0.9) {
      // Quartiles power qualitative intent ("cheap" = this business's own
      // bottom quartile). Recomputed on every sync, so they can't go stale.
      // A band contributes its midpoint here, but its true ends to min/max.
      const mids = spans.map((s) => (s.from + s.to) / 2).sort((a, b) => a - b);
      const q = (p) => round2(mids[Math.floor(p * (mids.length - 1))]);
      const currency = detectCurrency(vals);
      const unit = detectUnit(name);
      const isRange = spans.some((s) => s.from !== s.to);
      return {
        name, kind: "numeric",
        min: Math.min(...spans.map((s) => s.from)), max: Math.max(...spans.map((s) => s.to)),
        p25: q(0.25), p75: q(0.75),
        ...(currency ? { currency } : {}), ...(unit ? { unit } : {}), ...(isRange ? { isRange: true } : {}),
      };
    }
    const freq = new Map();
    for (const v of vals) {
      const s = String(v).trim();
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }
    const isCategorical = freq.size > 0 && freq.size <= MAX_DISTINCTS &&
      (freq.size <= 25 || freq.size / vals.length <= 0.5);
    if (isCategorical) {
      // Frequency-ordered so the tool description's top-25 shows what matters.
      const distincts = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
      return { name, kind: "categorical", distincts };
    }
    // A short, near-unique text column ("1955 Mercedes-Benz 300 SLR") is the
    // row's identity — what a person would call it. Single-token values with
    // digits (VINs, SKUs) don't read as names, so they stay plain text.
    const strs = vals.map((v) => String(v).trim());
    const avgLen = strs.reduce((a, s) => a + s.length, 0) / strs.length;
    const idCodes = strs.filter((s) => /^[\w-]*\d[\w-]*$/.test(s)).length;
    if (freq.size / vals.length >= 0.8 && avgLen <= 40 && idCodes / strs.length <= 0.5) {
      return { name, kind: "text", identityish: true };
    }
    return { name, kind: "text" };
  });
}

export function rowToItem(row, columns) {
  const structured = {};
  for (const col of columns) {
    const raw = row[col.name];
    if (col.kind !== "numeric") {
      structured[col.name] = raw === undefined || raw === null ? null : String(raw).trim();
      continue;
    }
    // A band filters and sorts on its midpoint (one comparable number per row)
    // but keeps its real ends alongside, so the answer quotes what the yard
    // actually published: "£8.20 to £8.70", never a made-up single figure.
    const span = col.isRange ? spanOf(raw) : null;
    if (span && span.from !== span.to) {
      structured[col.name] = round2((span.from + span.to) / 2);
      structured[`${col.name}_range`] = [span.from, span.to];
    } else {
      structured[col.name] = span ? span.from : parseNumericLike(raw);
    }
  }
  // Title = how a person would name this row out loud. Prefer SHORT
  // categorical values (grade, make, model, area) over long free-text columns
  // (descriptions), which otherwise swallow the title and make voice answers
  // unreadable: "Bright Copper London", not "Bright Copper Clean uncoated
  // unalloyed shiny copper wire London".
  const titleParts = [];
  const yearish = columns.find((c) => c.kind === "numeric" && /year/i.test(c.name));
  if (yearish && structured[yearish.name] != null) titleParts.push(structured[yearish.name]);
  const labelish = columns.filter((c) => {
    const value = String(structured[c.name] ?? "");
    return c.kind === "categorical"
      && (c.distincts?.length ?? 0) > 1        // same value on every row = no identity
      && !META_COL.test(c.name)                // last_updated, created_at, ...
      && !CODE_COL.test(c.name)                // postcodes and flags are not names
      && !DATE_LIKE.test(value)
      && value.length <= 25;
  });
  // The identity column ("car", "product name", or a near-unique short text
  // column) must lead when the label columns would drop it — otherwise rows
  // get named after whatever repeats: "RM Sotheby's Stuttgart" instead of the
  // car that sold there.
  const NAME_COL = /(^|_)(name|title|model|car|vehicle|product|item|material)(_|$)/i;
  const NON_NAME = /(^|_)(notes?|sources?|comments?|desc\w*|urls?|links?|images?)(_|$)/i;
  const identityOk = (c) => {
    const value = String(structured[c.name] ?? "");
    return c.kind !== "numeric" && value && value.length <= 60
      && !labelish.includes(c)                 // already titled? keep column order
      && !META_COL.test(c.name) && !DATE_LIKE.test(value);
  };
  const identity = columns.find((c) => identityOk(c) && NAME_COL.test(c.name))
    ?? columns.find((c) => identityOk(c) && c.identityish && !NON_NAME.test(c.name));
  if (identity) titleParts.push(structured[identity.name]);
  const fallback = columns.filter((c) => c.kind !== "numeric" && c !== identity);
  for (const c of (labelish.length ? labelish : fallback)) {
    if (titleParts.length >= 3) break;
    if (structured[c.name]) titleParts.push(structured[c.name]);
  }
  const body = columns.map((c) => structured[c.name]).filter((v) => v !== null && v !== "").join(" ");
  return { title: titleParts.join(" "), body, structured };
}
