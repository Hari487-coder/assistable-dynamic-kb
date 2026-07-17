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

export function inferColumnMeta(rows) {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  return names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const nums = vals.map(parseNumericLike).filter((n) => n !== null);
    if (vals.length > 0 && nums.length >= vals.length * 0.9) {
      return { name, kind: "numeric", min: Math.min(...nums), max: Math.max(...nums) };
    }
    const distinct = [...new Set(vals.map((v) => String(v).trim()))];
    if (distinct.length <= Math.max(25, rows.length * 0.05) && distinct.length <= 25) {
      return { name, kind: "categorical", distincts: distinct };
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
