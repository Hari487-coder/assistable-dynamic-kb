// "Within driving distance" search. A marketplace's core question is not
// "what do you have" but "what's NEAR ME" - callers give a postcode or a town
// and a distance they'll travel, exactly like the site's own search box.
//
// Rows opt in by carrying latitude/longitude columns; the caller's location is
// resolved through postcodes.io (free, no key, UK-wide: full postcodes,
// outcodes, and place names). Everything degrades softly: no geo columns, no
// resolvable location, or a dead geocoder just means the search runs without
// the distance leg - never an error.

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/**
 * The pair of columns that place a row on the map, or null. Detected by name
 * AND by value range, so a "latitude" column full of prices can't qualify.
 */
export function findGeoCols(columns) {
  const lat = columns.find((c) => c.kind === "numeric"
    && /(^|_)(lat|latitude)(_|$)/i.test(c.name) && c.min >= -90 && c.max <= 90);
  const lng = columns.find((c) => c.kind === "numeric"
    && /(^|_)(lng|lon|long|longitude)(_|$)/i.test(c.name) && c.min >= -180 && c.max <= 180);
  return lat && lng ? { lat: lat.name, lng: lng.name } : null;
}

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

// Location -> coordinates cache. Postcodes don't move; a day's TTL only
// exists so a transient geocoder failure (cached as null) can heal.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

// The places API returns candidates unranked: "Croydon" leads with a
// Cambridgeshire hamlet 50 miles from the London borough everyone means
// (found the hard way, live). When a name is ambiguous, the biggest
// settlement wins.
const PLACE_RANK = ["city", "town", "suburban area", "other settlement", "village", "hamlet"];
const placeRank = (t) => {
  const i = PLACE_RANK.indexOf(String(t ?? "").toLowerCase());
  return i === -1 ? PLACE_RANK.length : i;
};

async function lookup(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const body = await res.json();
  const list = Array.isArray(body.result) ? body.result : [body.result];
  const r = list.filter((x) => typeof x?.latitude === "number" && typeof x?.longitude === "number")
    .sort((a, b) => placeRank(a.local_type) - placeRank(b.local_type))[0];
  return r ? { lat: r.latitude, lng: r.longitude, label: r.postcode ?? r.outcode ?? r.name_1 ?? null } : null;
}

/** "CR4 4HX" | "SW19" | "Croydon" -> {lat, lng, label} | null. Never throws. */
export async function geocodeUK(place, fetchImpl = globalThis.fetch) {
  const q = String(place ?? "").trim();
  if (!q || q.length > 60) return null;
  const key = q.toLowerCase().replace(/\s+/g, " ");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
  let value = null;
  try {
    if (FULL_POSTCODE.test(q)) value = await lookup(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`, fetchImpl);
    else if (OUTCODE.test(q)) value = await lookup(`https://api.postcodes.io/outcodes/${encodeURIComponent(q)}`, fetchImpl);
    else value = await lookup(`https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=10`, fetchImpl);
  } catch { value = null; }
  cache.set(key, { value: value ? { ...value, label: value.label ?? q } : null, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return cache.get(key).value;
}

/**
 * The async pre-step that turns a spoken/typed location into `args._geo`
 * (coordinates) before the synchronous search. Shared so the live webhook AND
 * the portal's "Try it" run the identical path - otherwise the owner tests a
 * fiction. Soft everywhere: no geo columns, no location, or a dead geocoder
 * just returns args unchanged (or flags `_geoFail`), never throws.
 */
export async function resolveGeoArgs(columns, args, geocode = geocodeUK) {
  try {
    if (!Array.isArray(columns) || !findGeoCols(columns)) return args;
    const fromQuery = parseGeoFromQuery(String(args.query ?? ""));
    const near = typeof args.near === "string" && args.near.trim() ? args.near.trim() : fromQuery?.near;
    if (!near) return args;
    const radiusMiles = Number(args.radius_miles) > 0 ? Number(args.radius_miles) : fromQuery?.radiusMiles ?? 25;
    const pt = await geocode(near);
    return pt
      ? { ...args, _geo: { ...pt, radiusMiles }, query: fromQuery?.matched ? String(args.query ?? "").replace(fromQuery.matched, " ") : args.query }
      : { ...args, _geoFail: near };
  } catch { return args; }
}

const NOT_PLACES = new Set(["me", "here", "us", "you", "home", "we", "them"]);

/**
 * Spoken location intent -> {near, radiusMiles|null, matched}. Deliberately
 * conservative: "near me" is unanswerable in chat and must not geocode.
 */
export function parseGeoFromQuery(query) {
  const q = String(query ?? "");
  const within = q.match(/\bwithin\s+(\d{1,3})\s*(?:miles?|mi)\s*(?:of|from|around)?\s+([A-Za-z][A-Za-z0-9' -]{1,40}?)(?=[?.,!]|$)/i);
  if (within && !NOT_PLACES.has(within[2].trim().toLowerCase())) {
    return { near: within[2].trim(), radiusMiles: Math.min(500, Math.max(1, Number(within[1]))), matched: within[0] };
  }
  const pc = q.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  if (pc) return { near: pc[1], radiusMiles: null, matched: pc[0] };
  const near = q.match(/\b(?:near|around|close to)\s+([A-Za-z][A-Za-z' -]{1,40}?)(?=[?.,!]|$)/i);
  if (near && !NOT_PLACES.has(near[1].trim().toLowerCase())) {
    return { near: near[1].trim(), radiusMiles: null, matched: near[0] };
  }
  return null;
}
