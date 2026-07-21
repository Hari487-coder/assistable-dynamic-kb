export function parseNumericLike(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || /^(n\/a|na|null|-|none)$/.test(s)) return null;
  // "£7.20", "US$143,000,000", "GBP 7.20": one un-parsed currency style on a
  // price column demotes the whole column to text (no filters, no quartiles),
  // so strip code/symbol prefixes before deciding numeric-ness.
  s = s.replace(/^(usd|gbp|eur|inr|aud|cad|nzd)\s*(?=[\d$£€₹])|^(us|au|ca|nz)(?=\$)/, "");
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

export function inferColumnMeta(rows) {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  return names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const nums = vals.map(parseNumericLike).filter((n) => n !== null);
    if (vals.length > 0 && nums.length >= vals.length * 0.9) {
      // Quartiles power qualitative intent ("cheap" = this business's own
      // bottom quartile). Recomputed on every sync, so they can't go stale.
      const sorted = [...nums].sort((a, b) => a - b);
      const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
      return { name, kind: "numeric", min: sorted[0], max: sorted[sorted.length - 1], p25: q(0.25), p75: q(0.75) };
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
    structured[col.name] = col.kind === "numeric" ? parseNumericLike(raw) : (raw === undefined || raw === null ? null : String(raw).trim());
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
