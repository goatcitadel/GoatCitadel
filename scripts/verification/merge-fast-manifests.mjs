#!/usr/bin/env node
/**
 * Recomposes the partial manifests written by a sharded fast lane into the single
 * run manifest the rest of the tooling expects.
 *
 * CI runs `node scripts/verification/run.mjs fast --commands=<ids>` in several jobs
 * so the lane's fifteen minutes of tests can happen on more than one machine. Each
 * job writes its own artifact directory; this script merges them, re-derives the
 * counts, status and perf budgets over the whole set, and writes manifest.json,
 * summary.md, junit.xml and the perf artifact into one place.
 *
 * The merge is fail-closed on completeness: every command the lane defines must
 * appear exactly once across the parts. A dropped shard would otherwise produce a
 * green run that silently skipped whole checks, which is the failure mode splitting
 * a lane into jobs invites.
 *
 * Usage:
 *   node scripts/verification/merge-fast-manifests.mjs <part...> --out=<dir>
 *
 * Each <part> is either a manifest.json or a directory containing one (directly or
 * one level down, which is what actions/download-artifact produces).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createVerificationRunManifest } from "./lib/validation.mjs";
import { FAST_LANE_COMMANDS } from "./lib/scenarios/fast-lane.mjs";
import {
  FAST_LANE_PERF_ARTIFACT,
  artifactsRoot,
  buildFastLanePerfPayload,
  buildJunitXml,
  buildSummaryMarkdown,
  createRunId,
  deriveManifestStatus,
  maybeParseBool,
  parseCliArgs,
  repoRoot,
  tallyScenarioCounts,
  writeJson,
  writeText,
} from "./lib/shared.mjs";
import { acquireWorktreeOutputLock } from "../lib/worktree-output-lock.mjs";

// parts/<artifact-name>/artifacts/verification/<runId>/manifest.json is five levels
// below the directory the gate job hands over; leave headroom without turning the
// walk loose on the whole tree.
const MAX_MANIFEST_SEARCH_DEPTH = 6;

async function main() {
  const outputLockLease = await acquireWorktreeOutputLock({
    repoRoot,
    owner: "verification:fast-manifest-merge",
  });
  try {
    await mergeFastManifests();
  } finally {
    await outputLockLease.release();
  }
}

async function mergeFastManifests() {
  const { positional, options } = parseCliArgs(process.argv.slice(2));
  if (positional.length === 0) {
    throw new Error("Provide at least one manifest path or artifact directory to merge.");
  }

  const manifestPaths = [];
  for (const entry of positional) {
    manifestPaths.push(...(await findManifests(path.resolve(repoRoot, entry))));
  }
  if (manifestPaths.length === 0) {
    throw new Error(`No manifest.json found under: ${positional.join(", ")}.`);
  }

  const parts = [];
  for (const manifestPath of manifestPaths.sort()) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest.lane !== "fast") {
      throw new Error(`${manifestPath} is lane ${JSON.stringify(manifest.lane)}; only fast lane parts can be merged.`);
    }
    parts.push({ manifestPath, manifest });
  }

  const scenarios = parts.flatMap((part) => part.manifest.scenarios ?? []);
  assertNoDuplicateScenarios(scenarios);
  assertLaneIsComplete(scenarios, maybeParseBool(options["allow-partial"], false));

  const runId = typeof options["run-id"] === "string" ? options["run-id"] : createRunId("fast");
  const artifactRoot = path.resolve(repoRoot, String(options.out ?? path.join(artifactsRoot, runId)));
  const startedAt = earliest(parts.map((part) => part.manifest.startedAt));
  const finishedAt = latest([
    ...parts.map((part) => part.manifest.finishedAt),
    ...scenarios.map((scenario) => scenario.finishedAt),
  ]);

  const baseManifest = createVerificationRunManifest({
    runId,
    lane: "fast",
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    repoRoot,
    artifactRoot,
    scenarios,
    counts: tallyScenarioCounts(scenarios),
    metadata: {
      // commandSelection describes one part; the merged run is the whole lane.
      ...omit(parts[0]?.manifest?.metadata ?? {}, "commandSelection"),
      mergedFrom: parts.map((part) => part.manifest.runId),
      mergedPartCount: parts.length,
      mergedSelections: parts.map((part) => part.manifest.metadata?.commandSelection ?? null),
    },
  });

  const strict =
    String(process.env.GOATCITADEL_VERIFY_PERF_BUDGET ?? "")
      .trim()
      .toLowerCase() === "strict";
  const perf = buildFastLanePerfPayload(baseManifest, { strict });
  const status =
    perf.integrityFailure || (strict && perf.status === "failed") ? "failed" : deriveManifestStatus(baseManifest);
  const manifest = createVerificationRunManifest({
    ...baseManifest,
    status,
    metadata: {
      ...baseManifest.metadata,
      fastLanePerf: {
        artifact: FAST_LANE_PERF_ARTIFACT,
        status: perf.status,
        strict,
        integrityFailure: perf.integrityFailure,
      },
    },
  });

  await fs.mkdir(path.join(artifactRoot, "perf"), { recursive: true });
  await writeJson(path.join(artifactRoot, "manifest.json"), manifest);
  await writeJson(path.join(artifactRoot, FAST_LANE_PERF_ARTIFACT), perf);
  await writeText(path.join(artifactRoot, "summary.md"), buildSummaryMarkdown(manifest));
  await writeText(path.join(artifactRoot, "junit.xml"), buildJunitXml(manifest));
  // The pointer belongs beside the run it names, not in the repo's artifacts root.
  // Writing it to the fixed root made every merge — including this script's own
  // tests, which merge into a temp directory the test then deletes — repoint the
  // repo at a run that no longer exists. `verify:repo:hygiene` runs those tests in
  // the same job that later stages its manifest by following the pointer, so the
  // checks slice silently uploaded a part with no manifest in it.
  await writeJson(path.join(path.dirname(artifactRoot), "latest-run.json"), {
    runId,
    artifactRoot,
    startedAt: manifest.startedAt,
  });

  console.log(`Merged ${parts.length} fast lane part(s) into ${artifactRoot}`);
  console.log(`Scenarios: ${scenarios.length} | Status: ${manifest.status}`);
  if (manifest.status === "failed") {
    process.exitCode = 1;
  }
}

/**
 * Accepts a manifest path, a run directory, or any ancestor of several of them —
 * `actions/download-artifact` nests each part under its artifact name, so the gate
 * job points this at one directory and lets the walk find the parts.
 */
async function findManifests(target, depth = 0) {
  const stats = await fs.stat(target).catch(() => undefined);
  if (!stats) {
    throw new Error(`Merge input does not exist: ${target}.`);
  }
  if (stats.isFile()) {
    return [target];
  }
  const direct = path.join(target, "manifest.json");
  if (await exists(direct)) {
    return [direct];
  }
  if (depth >= MAX_MANIFEST_SEARCH_DEPTH) {
    return [];
  }
  const found = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }
    found.push(...(await findManifests(path.join(target, entry.name), depth + 1)));
  }
  return found;
}

async function exists(filePath) {
  return await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function assertNoDuplicateScenarios(scenarios) {
  const seen = new Set();
  const duplicates = new Set();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      duplicates.add(scenario.id);
    }
    seen.add(scenario.id);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Fast lane parts recorded the same scenario more than once: ${[...duplicates].join(", ")}. ` +
        "Two jobs ran overlapping --commands selections.",
    );
  }
}

function assertLaneIsComplete(scenarios, allowPartial) {
  const recorded = new Set(scenarios.map((scenario) => scenario.id));
  const missing = FAST_LANE_COMMANDS.map((command) => command.id).filter((id) => !recorded.has(id));
  if (missing.length === 0) {
    return;
  }
  const message =
    `Merged fast lane is missing ${missing.length} command(s): ${missing.join(", ")}. ` +
    "A job either failed to upload its manifest or the --commands selections do not cover the lane.";
  if (!allowPartial) {
    throw new Error(message);
  }
  console.warn(`[verify:fast:merge] ${message}`);
}

function omit(source, key) {
  const { [key]: _dropped, ...rest } = source;
  return rest;
}

function earliest(values) {
  const parsed = values.filter((value) => typeof value === "string").map((value) => Date.parse(value));
  const usable = parsed.filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    throw new Error("Fast lane parts carry no usable startedAt timestamp.");
  }
  return new Date(Math.min(...usable)).toISOString();
}

function latest(values) {
  const parsed = values.filter((value) => typeof value === "string").map((value) => Date.parse(value));
  const usable = parsed.filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    throw new Error("Fast lane parts carry no usable finishedAt timestamp.");
  }
  return new Date(Math.max(...usable)).toISOString();
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
