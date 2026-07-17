export const ALIASES = new Map(Object.entries({
  chevy: "chevrolet", vw: "volkswagen", benz: "mercedes-benz", "mercedes benz": "mercedes-benz",
  beemer: "bmw", bimmer: "bmw", subie: "subaru", lambo: "lamborghini", vette: "corvette",
}));

export const normalizeToken = (s) => String(s ?? "").toLowerCase().trim().replace(/[^\w\s-]/g, "");

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
