#!/usr/bin/env node
/*
 * Raw-values guard (UI audit 2026-10-14, workstream B). Operators never see wire values: enum tokens, IDs, raw ISO
 * timestamps, unrounded money or naive plurals. Times, money, sizes, durations and counts go through
 * @goatcitadel/mission-control-shared/content/format (or cockpit/ui/TimeText.tsx), statuses through the
 * status-vocabulary presenters, and IDs only through TechnicalDetails.
 *
 * Each pattern below is an exact ratchet for cockpit source (tests excluded): a count above its budget fails, and a
 * count below it fails too, so the budget is lowered in the same change and never creeps back up.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

export const RULES = [
  {
    id: "humanize-token",
    pattern: /\bhumanizeToken\(/g,
    budget: 30,
    help: "use a typed presenter from status-vocabulary (or an area *-vocabulary.ts); humanizeToken is for free-form text only",
  },
  {
    id: "manual-humanize",
    pattern: /\.replace(?:All)?\(\s*(?:["'`]_["'`]|\/_\/g)\s*,\s*["'`] ["'`]\s*\)/g,
    budget: 14,
    help: "underscore-stripping is humanizeToken by hand; use a typed presenter",
  },
  {
    id: "local-date-format",
    pattern:
      /new Date\([^)]*\)\.toLocale\w*String\(|\.toLocaleDateString\(|\.toLocaleTimeString\(|Intl\.DateTimeFormat|Intl\.RelativeTimeFormat/g,
    budget: 0,
    help: "show times with <TimeText> or the shared format helpers",
  },
  {
    id: "optional-plural",
    pattern: /\w\(s\)/g,
    budget: 0,
    help: 'write counts with plural() instead of "item(s)"',
  },
  {
    id: "inline-plural",
    pattern: /===\s*1\s*\?\s*["'`]{2}\s*:\s*["'`]s["'`]|!==\s*1\s*\?\s*["'`]s["'`]\s*:\s*["'`]{2}/g,
    budget: 0,
    help: "write counts with plural()",
  },
  {
    id: "jsx-raw-id",
    // Only rendered text counts: attribute values such as key={run.runId} are never shown.
    pattern: /(?<!=)\{\s*[\w?.!]+\.(?:workspaceId|providerId|actorId|runId|taskId|sessionId|approvalId)\s*\}/g,
    // 53: the two "Run <id>" run-detail headers (Sessions, classic Kanban) now read "Run"; the id stays in technical details.
    budget: 53,
    help: "show a name or plain label; put the ID in TechnicalDetails",
  },
];

// TimeText is the cockpit's date primitive; schedule-cadence only validates a time zone name and shows nothing.
const EXEMPT = { "local-date-format": new Set(["ui/TimeText.tsx", "areas/work/schedule-cadence.ts"]) };

export function countFile(relativePath, contents) {
  const counts = {};
  for (const rule of RULES) {
    if (EXEMPT[rule.id]?.has(relativePath)) continue;
    const hits = contents.match(rule.pattern)?.length ?? 0;
    if (rule.id === "jsx-raw-id" && !relativePath.endsWith(".tsx")) continue;
    if (hits) counts[rule.id] = hits;
  }
  return counts;
}

export function evaluate(totals, rules = RULES) {
  const failures = [];
  for (const rule of rules) {
    const count = totals[rule.id] ?? 0;
    if (count > rule.budget)
      failures.push(`${rule.id}: ${count} uses, budget ${rule.budget}. Remove the new ones: ${rule.help}.`);
    else if (count < rule.budget)
      failures.push(`${rule.id}: ${count} uses is below the budget of ${rule.budget}; lower the budget to ${count}.`);
  }
  return failures;
}

async function walk(dir) {
  // A directory that cannot be read must fail the guard, not pass silently.
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    }),
  );
  return groups.flat();
}

async function main() {
  const files = await walk(cockpitRoot);
  const totals = {};
  const byFile = {};
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const counts = countFile(relative, await fs.readFile(file, "utf8"));
    for (const [id, count] of Object.entries(counts)) {
      totals[id] = (totals[id] ?? 0) + count;
      (byFile[id] ??= []).push(`${relative} (${count})`);
    }
  }
  const failures = evaluate(totals);
  if (failures.length) {
    console.error("[raw-values] violations (see DESIGN.md › Copy):");
    for (const failure of failures) {
      console.error(`- ${failure}`);
      const id = failure.split(":")[0];
      if (process.env.RAW_VALUES_VERBOSE && byFile[id]) console.error(`  ${byFile[id].join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[raw-values] ${files.length} cockpit files within budget (${JSON.stringify(totals)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
