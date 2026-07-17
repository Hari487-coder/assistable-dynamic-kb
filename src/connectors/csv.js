import Papa from "papaparse";

export function parseCsvItems(text) {
  const parsed = Papa.parse(String(text).trim(), { header: true, skipEmptyLines: true });
  if (parsed.errors.some((e) => e.type === "Delimiter")) {
    const err = new Error("could not parse CSV"); err.permanent = true; throw err;
  }
  return { rows: parsed.data };
}
