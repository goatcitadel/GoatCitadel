// Failure-signature tripwire for the scheduled Release Proof workflow.
//
// A lane that has been red for days stops carrying information: nobody can
// tell a known-chronic failure from a fresh regression by conclusion color
// alone. This script re-arms that signal. It downloads the newest completed
// run's failure artifacts, extracts one normalized signature per failed
// scenario, and diffs them against the classified ledger in
// docs/ci/known-chronic-signatures.json:
//
//   - every signature matched by a ledger entry is "chronic red, no new
//     information";
//   - any unmatched signature is NEW and exits non-zero.
//
// Usage:
//   node scripts/ci-signature-tripwire.mjs                  # newest completed run
//   node scripts/ci-signature-tripwire.mjs --run <id>       # a specific run
//   node scripts/ci-signature-tripwire.mjs --update-ledger  # append NEW signatures
//                                                           # as unclassified entries
//   node scripts/ci-signature-tripwire.mjs --json           # machine-readable output
//
// The ledger is the authority on what red is tolerated; --update-ledger only
// drafts entries (classification "unclassified") that a human must finish.
// Requires the GitHub CLI (`gh`) authenticated for the repository in cwd.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_WORKFLOW = "Verification 1.0 Release Proof";
export const DEFAULT_MAX_ARTIFACT_MB = 25;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_PATH = path.join(REPO_ROOT, "docs", "ci", "known-chronic-signatures.json");

/** "required-lanes (verify:realtime:truth, realtime-truth, ubuntu-latest)" -> "realtime-truth" */
export function parseJobLane(jobName) {
  const match = /\(([^)]*)\)/.exec(jobName ?? "");
  if (!match) {
    return undefined;
  }
  const segments = match[1].split(",").map((part) => part.trim());
  return segments.length >= 2 ? segments[1] : undefined;
}

/**
 * Collapse run-specific noise (timestamps, uuids, hashes, ports, paths,
 * durations, ANSI) so the same defect produces the same signature text on
 * every run.
 */
export function normalizeSignatureText(input) {
  let text = String(input ?? "");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\[[0-9;]*m/g, "");
  text = text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>");
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  text = text.replace(/\b[0-9a-f]{12,64}\b/gi, "<hash>");
  text = text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  text = text.replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]+/g, "<path>");
  text = text.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/g, "<dur>");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 240);
}

/** Extract [{lane, scenarioId, text}] from one lane's review.json payload. */
export function extractLaneSignatures(lane, review) {
  const items = Array.isArray(review?.items) ? review.items : [];
  return items.map((item) => ({
    lane,
    scenarioId: String(item?.scenarioId ?? "unknown"),
    text: normalizeSignatureText(item?.summary ?? item?.title ?? "unknown failure"),
  }));
}

export function matchesLedgerEntry(signature, entry) {
  const lanes = Array.isArray(entry?.lanes) ? entry.lanes : [];
  if (!lanes.includes(signature.lane)) {
    return false;
  }
  const scenarioOk = entry.scenarioId === "*" || entry.scenarioId === signature.scenarioId;
  if (!scenarioOk) {
    return false;
  }
  if (entry.match === "*") {
    return true;
  }
  const needle = normalizeSignatureText(entry.match);
  return signature.text.includes(needle) || signature.scenarioId.includes(entry.match);
}

export function diffSignatures(signatures, ledgerEntries) {
  const chronic = [];
  const fresh = [];
  for (const signature of signatures) {
    const entry = (ledgerEntries ?? []).find((candidate) => matchesLedgerEntry(signature, candidate));
    if (entry) {
      chronic.push({ ...signature, classification: entry.classification });
    } else {
      fresh.push(signature);
    }
  }
  return { chronic, fresh };
}

/** Draft unclassified ledger entries for fresh signatures (returns a NEW ledger). */
export function appendFreshToLedger(ledger, freshSignatures, runId) {
  const additions = freshSignatures.map((signature) => ({
    lanes: [signature.lane],
    scenarioId: signature.scenarioId,
    match: signature.text.slice(0, 120),
    classification: "unclassified",
    detail: `Auto-drafted from run ${runId}; verify the mechanism before keeping.`,
    disposition: "TODO: classify (fixable / environmental / scenario-drift / held) and either fix or justify.",
  }));
  return { ...ledger, signatures: [...(ledger.signatures ?? []), ...additions] };
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", cwd: REPO_ROOT, ...options });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function resolveRun(runIdArg, workflow) {
  if (runIdArg) {
    const run = ghJson(["run", "view", String(runIdArg), "--json", "databaseId,conclusion,headSha,createdAt,status"]);
    return { id: run.databaseId, conclusion: run.conclusion, headSha: run.headSha, createdAt: run.createdAt };
  }
  const runs = ghJson([
    "run",
    "list",
    "--workflow",
    workflow,
    "--limit",
    "10",
    "--json",
    "databaseId,conclusion,headSha,createdAt,status",
  ]);
  const completed = runs.find((run) => run.status === "completed");
  if (!completed) {
    throw new Error(`No completed runs found for workflow "${workflow}".`);
  }
  return {
    id: completed.databaseId,
    conclusion: completed.conclusion,
    headSha: completed.headSha,
    createdAt: completed.createdAt,
  };
}

function collectRunSignatures(run, maxArtifactMb) {
  const view = ghJson(["run", "view", String(run.id), "--json", "jobs"]);
  const failedLanes = [
    ...new Set(
      (view.jobs ?? [])
        .filter((job) => job.conclusion === "failure")
        .map((job) => parseJobLane(job.name))
        .filter(Boolean),
    ),
  ];
  const artifacts = ghJson(["api", `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts`, "--jq", "."]).artifacts ?? [];
  const signatures = [];
  const skipped = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "ci-tripwire-"));
  try {
    for (const lane of failedLanes) {
      const artifactName = `verification-release-proof-${lane}-artifacts`;
      const artifact = artifacts.find((item) => item.name === artifactName);
      if (!artifact) {
        signatures.push({ lane, scenarioId: "*", text: `no artifact uploaded for failed lane ${lane}` });
        continue;
      }
      const sizeMb = artifact.size_in_bytes / (1024 * 1024);
      if (sizeMb > maxArtifactMb) {
        skipped.push({ lane, sizeMb: Math.round(sizeMb) });
        signatures.push({ lane, scenarioId: "*", text: `artifact too large to inspect (${Math.round(sizeMb)}MB)` });
        continue;
      }
      const dest = path.join(scratch, lane);
      gh(["run", "download", String(run.id), "-n", artifactName, "-D", dest]);
      const reviews = findFiles(dest, "review.json");
      if (reviews.length === 0) {
        signatures.push({ lane, scenarioId: "*", text: "artifact contains no review.json" });
        continue;
      }
      for (const reviewPath of reviews) {
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        signatures.push(...extractLaneSignatures(lane, review));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { signatures, skipped, failedLanes };
}

function findFiles(root, name) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, name));
    } else if (entry.name === name) {
      results.push(full);
    }
  }
  return results;
}

export function formatReport(run, diff, skipped, { json = false } = {}) {
  if (json) {
    return JSON.stringify({ run, ...diff, skipped }, null, 2);
  }
  const lines = [
    `Release Proof run ${run.id} (${run.createdAt}, ${String(run.headSha).slice(0, 9)}) concluded: ${run.conclusion}`,
  ];
  for (const item of diff.chronic) {
    lines.push(`  chronic  ${item.lane} / ${item.scenarioId} [${item.classification}]`);
  }
  for (const item of diff.fresh) {
    lines.push(`  NEW      ${item.lane} / ${item.scenarioId}: ${item.text.slice(0, 160)}`);
  }
  for (const item of skipped) {
    lines.push(`  (skipped ${item.lane} artifact download: ${item.sizeMb}MB over cap)`);
  }
  lines.push(
    diff.fresh.length === 0
      ? `0 new signatures (${diff.chronic.length} chronic).`
      : `${diff.fresh.length} NEW signature(s) — triage required.`,
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const readFlag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const runIdArg = readFlag("--run");
  const maxArtifactMb = Number(readFlag("--max-artifact-mb") ?? DEFAULT_MAX_ARTIFACT_MB);
  const wantJson = args.includes("--json");
  const updateLedger = args.includes("--update-ledger");

  const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  const run = resolveRun(runIdArg, ledger.workflow ?? DEFAULT_WORKFLOW);
  if (run.conclusion === "success") {
    console.log(`Release Proof run ${run.id} concluded: success — 0 new signatures.`);
    return;
  }
  const { signatures, skipped } = collectRunSignatures(run, maxArtifactMb);
  const diff = diffSignatures(signatures, ledger.signatures);
  console.log(formatReport(run, diff, skipped, { json: wantJson }));
  if (diff.fresh.length > 0 && updateLedger) {
    const next = appendFreshToLedger(ledger, diff.fresh, run.id);
    writeFileSync(LEDGER_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Drafted ${diff.fresh.length} unclassified entr(ies) into ${path.relative(REPO_ROOT, LEDGER_PATH)}.`);
  }
  if (diff.fresh.length > 0) {
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  await main();
}
