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
const nativeRoutes = path.join(repoRoot, "apps", "mission-control-next", "src", "features", "native-routes");

/** The cockpit's own areas, plus the Classic settings and ops panels it still mounts until Phase 3 ports them. */
export const RAW_VALUE_ROOTS = [
  { id: "cockpit", dir: cockpitRoot },
  { id: "native-settings", dir: path.join(nativeRoutes, "settings") },
  { id: "native-ops", dir: path.join(nativeRoutes, "ops") },
];

export const RULES = [
  {
    id: "humanize-token",
    pattern: /\bhumanizeToken\(/g,
    budget: 27,
    help: "use a typed presenter from status-vocabulary (or an area *-vocabulary.ts); humanizeToken is for free-form text only",
  },
  {
    id: "manual-humanize",
    pattern: /\.replace(?:All)?\(\s*(?:["'`]_["'`]|\/_\/g)\s*,\s*["'`] ["'`]\s*\)/g,
    budget: 13,
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
    pattern:
      /(?<!=)\{\s*[\w?.!]+\.(?:workspaceId|providerId|actorId|runId|taskId|sessionId|approvalId|grantId|localOperatorOverrideId)\s*\}/g,
    // IDs inside TechnicalDetails and key/href templates don't count; the run-detail headers read "Run" with the id in
    // technical details. Autonomous grants name their revoke action by reason and keep their IDs in technical details;
    // what remains is mostly browser-session actor IDs, which are the grant's visible subject.
    budget: 23,
    help: "show a name or plain label; put the ID in TechnicalDetails",
  },
  {
    id: "raw-iso-time",
    // A timestamp field rendered as text shows an ISO string; value={…At} props (TimeText) are excluded.
    pattern: /(?<!=)\{\s*[\w?.!]+At\s*\}/g,
    budget: 0,
    help: "show times with <TimeText value={…} /> or put them in TechnicalDetails",
  },
  {
    id: "raw-error-text",
    // Server-recorded error text on a record (run.lastError, step.error). Hook state such as owner.error is already
    // presented by describeApiError, so it is not counted.
    pattern: /(?<!=)\{\s*(?:[\w?.!]+\.lastError|(?:[\w?!]+\.)*(?:step|report|run|effect|record|item|data|tool)\??\.error)\s*\}/g,
    budget: 0,
    help: "render presentErrorText(…).summary and put the raw text in TechnicalDetails",
  },
];

/** Rules that only read rendered JSX, so plain .ts files never count toward them. */
const JSX_ONLY = new Set(["jsx-raw-id", "raw-iso-time", "raw-error-text"]);

/*
 * Budgets per root, overriding the rule budget. The Classic settings and ops panels are pinned at their counts on
 * the day this guard reached them and ratchet down as Phase 3 ports them.
 */
export const ROOT_BUDGETS = {
  cockpit: {},
  "native-settings": {
    "humanize-token": 4,
    "manual-humanize": 35,
    "local-date-format": 10,
    "optional-plural": 3,
    "inline-plural": 11,
    "jsx-raw-id": 16,
    "raw-iso-time": 8,
    "raw-error-text": 7,
  },
  "native-ops": {
    "humanize-token": 0,
    "manual-humanize": 10,
    "local-date-format": 10,
    "inline-plural": 7,
    "jsx-raw-id": 15,
    "raw-iso-time": 4,
    "raw-error-text": 1,
  },
};

// TimeText is the cockpit's date primitive; schedule-cadence only validates a time zone name and shows nothing.
const EXEMPT = { "local-date-format": new Set(["ui/TimeText.tsx", "areas/work/schedule-cadence.ts"]) };

/*
 * TechnicalDetails children are where IDs, raw times and raw errors belong, and key/href/to/data-* templates are never
 * rendered; blank both, keeping line breaks.
 */
function stripTechnicalDetails(contents) {
  return contents
    .replace(/(<TechnicalDetails\b[^>]*>)([\s\S]*?)(<\/TechnicalDetails>)/g, (_, open, body, close) => {
      return `${open}${body.replace(/[^\n]/g, "")}${close}`;
    })
    .replace(/\b(?:key|href|to|data-[\w-]+)=\{`[^`]*`\}/g, "");
}

export function countFile(relativePath, contents) {
  const counts = {};
  const visible = stripTechnicalDetails(contents);
  for (const rule of RULES) {
    if (EXEMPT[rule.id]?.has(relativePath)) continue;
    if (JSX_ONLY.has(rule.id) && !relativePath.endsWith(".tsx")) continue;
    const hits = (JSX_ONLY.has(rule.id) ? visible : contents).match(rule.pattern)?.length ?? 0;
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

async function scanRoot(root) {
  const files = await walk(root.dir);
  const totals = {};
  const byFile = {};
  for (const file of files) {
    const relative = path.relative(root.dir, file).split(path.sep).join("/");
    const counts = countFile(relative, await fs.readFile(file, "utf8"));
    for (const [id, count] of Object.entries(counts)) {
      totals[id] = (totals[id] ?? 0) + count;
      (byFile[id] ??= []).push(`${relative} (${count})`);
    }
  }
  const budgets = ROOT_BUDGETS[root.id] ?? {};
  const rules = RULES.map((rule) => ({ ...rule, budget: budgets[rule.id] ?? rule.budget }));
  return { files, totals, byFile, failures: evaluate(totals, rules) };
}

async function main() {
  let fileCount = 0;
  const summary = {};
  for (const root of RAW_VALUE_ROOTS) {
    const { files, totals, byFile, failures } = await scanRoot(root);
    fileCount += files.length;
    summary[root.id] = totals;
    if (!failures.length) continue;
    console.error(`[raw-values] ${root.id}: violations (see DESIGN.md › Copy):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
      const id = failure.split(":")[0];
      if (process.env.RAW_VALUES_VERBOSE && byFile[id]) console.error(`  ${byFile[id].join(", ")}`);
    }
    process.exitCode = 1;
  }
  if (!process.exitCode) console.log(`[raw-values] ${fileCount} files within budget (${JSON.stringify(summary)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
