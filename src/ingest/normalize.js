export function parseNumericLike(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || /^(n\/a|na|null|-|none)$/.test(s)) return null;
  let mult = 1;
  if (/^\$?[\d,.]+\s*k$/.test(s)) { mult = 1000; s = s.replace(/k$/, ""); }
  s = s.replace(/[$,\s]/g, "").replace(/(km|mi|miles|kms)$/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * mult;
}

// Filterable-categorical ceiling. A 1,000-row inventory legitimately has 60+
// models; treating those as free text would silently drop exact filtering —
// the same failure the static KB has. IDs (VINs, SKUs) stay text because their
// distinct-ratio is ~1.
const MAX_DISTINCTS = 500;

export function inferColumnMeta(rows) {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  return names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const nums = vals.map(parseNumericLike).filter((n) => n !== null);
    if (vals.length > 0 && nums.length >= vals.length * 0.9) {
      return { name, kind: "numeric", min: Math.min(...nums), max: Math.max(...nums) };
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
    return { name, kind: "text" };
  });
}

export function rowToItem(row, columns) {
  const structured = {};
  for (const col of columns) {
    const raw = row[col.name];
    structured[col.name] = col.kind === "numeric" ? parseNumericLike(raw) : (raw === undefined || raw === null ? null : String(raw).trim());
  }
  const titleParts = [];
  const yearish = columns.find((c) => c.kind === "numeric" && /year/i.test(c.name));
  if (yearish && structured[yearish.name] != null) titleParts.push(structured[yearish.name]);
  for (const c of columns) {
    if (titleParts.length >= 3) break;
    if (c.kind !== "numeric" && structured[c.name]) titleParts.push(structured[c.name]);
  }
  const body = columns.map((c) => structured[c.name]).filter((v) => v !== null && v !== "").join(" ");
  return { title: titleParts.join(" "), body, structured };
}
