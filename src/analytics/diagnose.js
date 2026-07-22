// Rules that read a diagnostic bundle and say what is wrong with the instance.
//
// This is the support knowledge written down. Every rule here exists because it
// is a real way a Live KB goes wrong in a way the owner cannot see: the tool
// that was never attached to an assistant, the price column that parsed as text
// so "cheapest" silently does nothing, the instance still in mock mode. Reading
// a 200KB JSON bundle by eye finds none of these reliably; the rules do.
//
// Pure functions over a plain object, so they are unit-testable and could later
// run inside the portal to tell the owner directly.

const MONEYISH = /price|cost|rate|amount|fee|value|msrp|per_kg|per_lb|per_tonne|total|salary|budget/i;

const f = (severity, title, detail, fix) => ({ severity, title, detail, fix });

/** Instance-wide rules. */
export const INSTANCE_RULES = [
  {
    id: "mock-mode",
    run: (b) => b.instance.mockAssistable && b.sources.length
      ? f("critical", "Instance is in mock mode",
        "MOCK_ASSISTABLE is not '0', so tool creation is only logged, never sent to Assistable. Tools will appear to succeed here and not exist in the customer's account.",
        "Set MOCK_ASSISTABLE=0 in the host's environment and redeploy, then delete and re-add each source so its tool is really created.")
      : null,
  },
  {
    id: "not-connected",
    run: (b) => b.instance.connectionStatus !== "verified" && b.sources.length
      ? f("critical", `Assistable connection is '${b.instance.connectionStatus}'`,
        "Sources exist but the Assistable account is not verified, so no tool can be created or attached.",
        "Connection page: paste a v3 API key with assistants:list, tools:create, tools:update.")
      : null,
  },
  {
    id: "key-on-disk",
    run: (b) => b.instance.encryptionKeyFromEnv === false
      ? f("warning", "Encryption key lives on the instance disk",
        "The key was auto-generated into the data dir. If the host resets the disk (Render free tier does on every redeploy), it is destroyed and every downloaded backup becomes permanently undecryptable.",
        "Copy data/.encryption-key into an ENCRYPTION_KEY env var on the host.")
      : null,
  },
  {
    id: "unclaimable",
    run: (b) => b.instance.signups === "first-only" && !b.instance.setupTokenSet && b.instance.userCount > 0
      ? f("warning", "No SETUP_TOKEN on a first-only instance",
        "If the disk resets, the users table empties and the next visitor to reach /signup claims the instance.",
        "Set a SETUP_TOKEN env var on the host so only the deployer can claim it after a wipe.")
      : null,
  },
  {
    id: "no-sources",
    run: (b) => b.sources.length === 0
      ? f("info", "No sources configured", "The instance is running but has no data connected yet.", "Add a source from Your data.")
      : null,
  },
];

/** Per-source rules. Each gets (source, bundle). */
export const SOURCE_RULES = [
  {
    id: "sync-failing",
    run: (s) => s.status === "error" || s.consecutiveFailures > 0
      ? f("critical", "Syncs are failing",
        `status=${s.status}, ${s.consecutiveFailures} consecutive failure(s). Last error: ${s.syncRuns.find((r) => r.error)?.error ?? "unknown"}`,
        "Fix the source config (URL reachable, credentials valid, robots.txt allows it) and press Refresh data now.")
      : null,
  },
  {
    id: "never-synced",
    run: (s) => !s.hasActiveBatch
      ? f("critical", "No live data",
        "This source has no active batch, so every agent call returns not_synced and the assistant will say it cannot check.",
        "Press Refresh data now and check the sync history for the error.")
      : null,
  },
  {
    id: "empty-batch",
    run: (s) => s.hasActiveBatch && s.itemCount === 0
      ? f("critical", "Active batch is empty",
        "The batch being served has zero items, so every question returns nothing.",
        "Roll back to the previous batch, then fix the feed and re-sync.")
      : null,
  },
  {
    id: "tool-missing",
    run: (s) => !s.tool.created
      ? f("critical", "No tool in Assistable",
        `The tool was never created${s.tool.lastError ? `: ${s.tool.lastError}` : ""}. The agent has no way to reach this data.`,
        "Verify the Assistable connection, then delete and re-add this source.")
      : null,
  },
  {
    id: "tool-unattached",
    run: (s) => s.tool.created && s.tool.assistantCount === 0
      ? f("critical", "Tool is attached to zero assistants",
        "The tool exists but no assistant can call it, so live data is never used on calls or chats.",
        "Open the source and tick the assistants that should use it.")
      : null,
  },
  {
    id: "schema-stale-on-voice",
    run: (s) => s.tool.schemaChangedSinceCreate
      ? f("warning", "Tool schema changed after creation",
        "Voice assistants cache the tool schema when the assistant is saved. Until it is re-saved, phone calls use the old filters.",
        "Open the assistant in Assistable and press Save once.")
      : null,
  },
  {
    id: "money-column-is-text",
    run: (s) => {
      const bad = s.columns.filter((c) => MONEYISH.test(c.name) && c.kind !== "numeric");
      return bad.length
        ? f("critical", `Price column parsed as ${bad[0].kind}, not a number`,
          `Columns: ${bad.map((c) => c.name).join(", ")}. Range filters ("under 30k"), sorting ("cheapest") and quartiles ("cheap") all silently do nothing on a text column. Usually a currency or number format we do not parse yet - prices written as words ("seven fifty"), or with trailing prose ("£4.05 negotiable"). Placeholder values (POA, call for price, TBC) and bands ("£8.20 - £8.70") are already handled and do not cause this.`,
          "Check the raw values for that column: they need to be numbers, optionally with a currency symbol or a from-to band. If the format looks reasonable and still lands here, that is a parser fix.")
        : null;
    },
  },
  {
    id: "no-numeric-columns",
    run: (s) => s.type !== "website" && s.columns.length > 0 && !s.columns.some((c) => c.kind === "numeric")
      ? f("warning", "No numeric columns detected",
        "Without a numeric column the tool advertises no range filters, so 'under 30k' and 'cheapest' cannot work.",
        "If this data does have prices or years, they are not parsing - check their formatting.")
      : null,
  },
  {
    id: "no-identity-column",
    run: (s) => s.type !== "website" && s.columns.length > 0
      && !s.columns.some((c) => c.identityish || /(^|_)(name|title|model|car|vehicle|product|item|material)(_|$)/i.test(c.name))
      ? f("warning", "No obvious name column",
        "Nothing in this data reads as the row's identity, so spoken answers may name rows by whatever repeats instead of what the thing is.",
        "Make sure the column holding the item's name is present and not all-numeric.")
      : null,
  },
  {
    id: "dead-ends",
    run: (s) => s.quality.total >= 10 && s.quality.deadEndPct >= 25
      ? f("warning", `${s.quality.deadEndPct}% of questions found nothing`,
        `${s.quality.noMatch} of ${s.quality.total} questions dead-ended. Top misses: ${(s.quality.unanswered ?? []).slice(0, 5).map((u) => `"${u.query}"`).join(", ") || "(questions not shared)"}`,
        "Usually missing rows rather than a search bug: add the items people ask for, or extend the data's vocabulary.")
      : null,
  },
  {
    id: "slow",
    run: (s) => s.quality.total >= 5 && s.quality.p95 > 1000
      ? f("warning", `p95 latency ${s.quality.p95}ms, over the 1s budget`,
        "Voice has ~10s for the whole round trip through the platform; a slow tool makes the caller hear silence.",
        "Check instance resources and item counts. On a free host this is often cold start rather than query cost.")
      : null,
  },
  {
    id: "checks-regressed",
    run: (s) => s.checks.regressed?.length
      ? f("critical", `${s.checks.regressed.length} question(s) stopped answering`,
        s.checks.regressed.slice(0, 5).map((r) => `"${r.question}" - ${r.detail}`).join(" | "),
        "These worked before. Compare against the sync history: a feed that changed shape or dropped rows is the usual cause. Roll back if the last sync did it.")
      : null,
  },
  {
    id: "checks-flagged",
    run: (s) => s.checks.flagged?.length
      ? f("critical", `${s.checks.flagged.length} answer(s) the owner marked wrong`,
        s.checks.flagged.slice(0, 5).map((r) => `"${r.question}"${r.note ? ` - ${r.note}` : ""}`).join(" | "),
        "The owner's own verdict, so treat as ground truth. Reproduce with Try it, then look at the matched rows.")
      : null,
  },
  {
    id: "stale-data",
    run: (s) => {
      if (!s.lastSyncAt || !s.scheduleMinutes) return null;
      const ageMin = (Date.now() - Date.parse(s.lastSyncAt)) / 60000;
      return ageMin > s.scheduleMinutes * 3
        ? f("warning", "Data is older than its schedule",
          `Last sync ${Math.round(ageMin / 60)}h ago on a ${s.scheduleMinutes}min schedule. The scheduler may not be running (host asleep, or the process restarts before the job fires).`,
          "Check the instance stays awake and the sync history for repeated failures.")
        : null;
    },
  },
];

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/** Run every rule over a bundle -> a sorted, human-ordered finding list. */
export function diagnose(bundle) {
  const findings = [];
  for (const rule of INSTANCE_RULES) {
    try {
      const hit = rule.run(bundle);
      if (hit) findings.push({ ...hit, id: rule.id, scope: "instance" });
    } catch { /* a broken rule must never break the report */ }
  }
  for (const s of bundle.sources ?? []) {
    for (const rule of SOURCE_RULES) {
      try {
        const hit = rule.run(s, bundle);
        if (hit) findings.push({ ...hit, id: rule.id, scope: s.name || s.id });
      } catch { /* same */ }
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return findings;
}
