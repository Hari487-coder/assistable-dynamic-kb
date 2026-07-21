#!/usr/bin/env node
// Read a diagnostic bundle a Live KB owner sent you and say what is wrong.
//
//   node tools/diagnose.mjs their-bundle.json
//   node tools/diagnose.mjs their-bundle.json --json
//
// Nothing here touches the network or their instance; it is a pure read of the
// file they chose to share.

import fs from "node:fs";
import { diagnose } from "../src/analytics/diagnose.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("-"));
const asJson = args.includes("--json");

if (!file) {
  console.error("usage: node tools/diagnose.mjs <bundle.json> [--json]");
  process.exit(2);
}

let bundle;
try {
  bundle = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(2);
}
if (bundle.bundle !== "live-kb-diagnostics") {
  console.error("That file is not a Live KB diagnostic bundle.");
  process.exit(2);
}

const findings = diagnose(bundle);
if (asJson) {
  console.log(JSON.stringify({ instance: bundle.instance, findings }, null, 2));
  process.exit(findings.some((f) => f.severity === "critical") ? 1 : 0);
}

const C = process.stdout.isTTY
  ? { red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", off: "\x1b[0m" }
  : { red: "", yellow: "", dim: "", bold: "", green: "", off: "" };
const TONE = { critical: C.red, warning: C.yellow, info: C.dim };

const i = bundle.instance;
console.log(`${C.bold}Live KB diagnostics${C.off} ${C.dim}(bundle v${bundle.bundleVersion}, generated ${bundle.generatedAt})${C.off}`);
console.log(`  host ${i.baseUrlHost ?? "?"} | app ${i.appVersion ?? "?"} | node ${i.node} | up ${Math.round((i.uptimeSeconds ?? 0) / 60)}m`);
console.log(`  signups=${i.signups ?? "?"} mock=${i.mockAssistable} connection=${i.connectionStatus} sources=${i.sourceCount}`);
if (!bundle.options?.includeQuestions) console.log(`  ${C.dim}note: owner excluded the questions, so retrieval findings are limited${C.off}`);

console.log(`\n${C.bold}Sources${C.off}`);
for (const s of bundle.sources ?? []) {
  const q = s.quality ?? {};
  console.log(`  ${C.bold}${s.name}${C.off} ${C.dim}(${s.type}, ${s.status})${C.off}`);
  console.log(`    ${s.itemCount} items | ${s.columns.length} columns | tool ${s.tool.created ? `on ${s.tool.assistantCount} assistant(s)` : "NOT created"}`);
  console.log(`    last 7d: ${q.total ?? 0} questions, ${q.helpedPct ?? 0}% helped, ${q.deadEndPct ?? 0}% dead end, p95 ${q.p95 ?? 0}ms`);
  console.log(`    checks: ${s.checks.passing}/${s.checks.total} passing${s.checks.regressed?.length ? `, ${s.checks.regressed.length} regressed` : ""}${s.checks.flagged?.length ? `, ${s.checks.flagged.length} flagged wrong` : ""}`);
  const cols = s.columns.map((c) => `${c.name}:${c.kind}${c.currency ? `(${c.currency})` : ""}`).join(" ");
  if (cols) console.log(`    ${C.dim}${cols}${C.off}`);
}

console.log(`\n${C.bold}Findings${C.off}`);
if (!findings.length) {
  console.log(`  ${C.green}Nothing flagged.${C.off} If the customer still reports a problem, look at the recent questions below.`);
} else {
  for (const fi of findings) {
    console.log(`\n  ${TONE[fi.severity]}${C.bold}[${fi.severity.toUpperCase()}]${C.off} ${fi.title} ${C.dim}- ${fi.scope}${C.off}`);
    console.log(`    ${fi.detail}`);
    console.log(`    ${C.green}fix:${C.off} ${fi.fix}`);
  }
}

// The questions themselves are usually the fastest route to "why did it say
// that", so surface the worst ones rather than making someone open the JSON.
for (const s of bundle.sources ?? []) {
  const bad = (s.recentCalls ?? []).filter((c) => c.outcome === "no_match" || c.outcome === "weak");
  if (!bad.length) continue;
  console.log(`\n${C.bold}Recent questions that struggled${C.off} ${C.dim}- ${s.name}${C.off}`);
  for (const c of bad.slice(0, 10)) {
    console.log(`  ${C.dim}${c.ts?.slice(0, 16) ?? ""}${C.off} "${c.question}" ${C.dim}-> ${c.outcome}, ${c.resultCount ?? 0} results, ${c.tookMs}ms${C.off}`);
  }
}

console.log("");
process.exit(findings.some((f) => f.severity === "critical") ? 1 : 0);
