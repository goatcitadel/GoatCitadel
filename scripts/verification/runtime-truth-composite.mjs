#!/usr/bin/env node
// verify:runtime:truth composite runner.
//
// Runs the five runtime-truth release-proof components with CONTINUE-ON-ERROR
// semantics and reports a per-component pass / skip / fail summary. This
// replaces the previous `&&`-chained command whose short-circuit at component 1
// (the browser lane, which conditionally SKIPS when no UI-served environment is
// present) masked the four standalone-green parity components behind it. The
// invariant this runner exists to enforce: a single environmental red must
// never hide the green lanes — every component runs and is reported, and the
// composite fails only on a genuine per-component failure.
//
// The three hermetic-PostgreSQL components (mesh / journey-producers /
// remote-workers) are run STRICTLY SEQUENTIALLY. Each proof provisions and — in
// its own process, before that process exits — fully tears down its throwaway
// cluster (pg_ctl stop -m fast + PGDATA removal, plus a stop on every failure
// path). Running them one at a time therefore guarantees a full cluster
// teardown before the next one provisions, so back-to-back cluster contention
// (a lingering postmaster colliding with the next lane's port) cannot occur.
// runtime-truth runs FIRST so it writes latest-run.json for the downstream
// `verify:review` step, exactly as the previous chain did.
//
// Exit code: 0 when every component passed (a conditional skip is not a
// failure); 1 when any component genuinely failed. This lane builds NO product
// code and re-implements no assertion owned by a composed component.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const startedAt = new Date();

// Ordered exactly as the previous `&&` chain. `hermeticPostgres` marks the
// components that spin a throwaway PostgreSQL cluster; they are contiguous and
// run one-at-a-time (see the serialization note above).
const COMPONENTS = [
  {
    id: "runtime-truth",
    label: "Runtime-truth browser lane (durable truth + conditional shell cross-check)",
    script: "scripts/verification/run.mjs",
    args: ["runtime-truth"],
  },
  {
    id: "mcp-requester-scope",
    label: "HX-415 requester-scoped MCP proof",
    script: "scripts/verification/mcp-requester-scope-proof.mjs",
    args: [],
  },
  {
    id: "mesh-capability-publication",
    label: "HX-408 mesh capability-publication proof (hermetic PostgreSQL)",
    script: "scripts/verification/mesh-capability-publication-proof.mjs",
    args: [],
    hermeticPostgres: true,
  },
  {
    id: "journey-producers",
    label: "HX-402 journey-producers proof (hermetic PostgreSQL)",
    script: "scripts/verification/journey-producers-proof.mjs",
    args: [],
    hermeticPostgres: true,
  },
  {
    id: "remote-workers",
    label: "Phase-5 remote-workers integrated proof (hermetic PostgreSQL)",
    script: "scripts/verification/remote-workers-proof.mjs",
    args: [],
    hermeticPostgres: true,
  },
];

// Lines a component prints when a scenario / proof-matrix row is a documented
// conditional skip. Parsed only to ANNOTATE a passing component's summary —
// never to change its pass/fail verdict, which the exit code alone owns.
const SKIP_MARKERS = [/->\s*SKIP\b/u, /\bSKIP:/u, /skipped[_-]with[_-]reason/iu, /"status":\s*"skipped"/iu];

function collectSkipAnnotations(output) {
  const notes = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (SKIP_MARKERS.some((pattern) => pattern.test(line))) {
      notes.add(line.slice(0, 240));
    }
  }
  return [...notes].slice(0, 16);
}

function runComponent(component) {
  return new Promise((resolve) => {
    const startedMs = Date.now();
    const bar = "=".repeat(78);
    process.stdout.write(
      `\n${bar}\n[component] ${component.id} — ${component.label}\n` +
        `  node ${component.script}${component.args.length ? ` ${component.args.join(" ")}` : ""}\n${bar}\n`,
    );
    const child = spawn(process.execPath, [path.join(repoRoot, component.script), ...component.args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let combined = "";
    // Tee: stream each chunk straight through to the operator AND buffer it so
    // the skip-annotation parser can read the component's full output.
    const tee = (streamName) => (chunk) => {
      const text = chunk.toString("utf8");
      combined += text;
      process[streamName].write(text);
    };
    child.stdout.on("data", tee("stdout"));
    child.stderr.on("data", tee("stderr"));
    child.once("error", (error) => {
      resolve({
        id: component.id,
        label: component.label,
        hermeticPostgres: component.hermeticPostgres === true,
        status: "failed",
        exitCode: null,
        durationMs: Date.now() - startedMs,
        skipAnnotations: [],
        spawnError: String(error),
      });
    });
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        id: component.id,
        label: component.label,
        hermeticPostgres: component.hermeticPostgres === true,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        durationMs: Date.now() - startedMs,
        skipAnnotations: collectSkipAnnotations(combined),
      });
    });
  });
}

const results = [];
for (const component of COMPONENTS) {
  // Strictly sequential (await each to full exit before the next spawns): the
  // hermetic-PostgreSQL components must never overlap, and each fully tears down
  // its cluster before its process exits, so one-at-a-time execution serializes
  // the cluster lifecycle end-to-end.
  const result = await runComponent(component);
  results.push(result);
  process.stdout.write(
    `\n[component ${result.id}] -> ${result.status.toUpperCase()}` +
      `${result.exitCode === null ? " (spawn error)" : ` (exit ${result.exitCode})`}` +
      ` in ${(result.durationMs / 1000).toFixed(1)}s` +
      `${result.skipAnnotations.length ? ` — carried ${result.skipAnnotations.length} conditional skip(s)` : ""}\n`,
  );
}

const failed = results.filter((result) => result.status === "failed");
const passed = results.filter((result) => result.status === "passed");
const passedWithSkips = passed.filter((result) => result.skipAnnotations.length > 0);
const overall = failed.length === 0 ? "passed" : "failed";

const bar = "#".repeat(78);
process.stdout.write(`\n${bar}\nverify:runtime:truth composite summary (${results.length} components)\n${bar}\n`);
for (const result of results) {
  const verdict = result.status === "failed" ? "FAIL" : result.skipAnnotations.length ? "PASS (skips)" : "PASS";
  process.stdout.write(`  ${verdict.padEnd(13)} ${result.id.padEnd(30)} ${(result.durationMs / 1000).toFixed(1)}s\n`);
  for (const note of result.skipAnnotations) process.stdout.write(`       · ${note}\n`);
  if (result.spawnError) process.stdout.write(`       ! spawn error: ${result.spawnError}\n`);
}

// Composite manifest artifact — the release-proof workflow uploads
// artifacts/verification with `if-no-files-found: error`, and each component
// also writes its own artifact directory there.
const artifactDir = path.join(repoRoot, "artifacts", "verification");
fs.mkdirSync(artifactDir, { recursive: true });
const artifactPath = path.join(
  artifactDir,
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-runtime-truth-composite-${randomBytes(4).toString("hex")}.json`,
);
fs.writeFileSync(
  artifactPath,
  `${JSON.stringify(
    {
      version: "runtime_truth_composite.v1",
      lane: "verify:runtime:truth",
      status: overall,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      componentsPassed: passed.length,
      componentsFailed: failed.length,
      componentsWithConditionalSkips: passedWithSkips.length,
      components: results,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`\nComposite artifact: ${artifactPath}\n`);
process.stdout.write(
  `Components: ${passed.length} passed / ${failed.length} failed (${passedWithSkips.length} carried conditional skips)\n`,
);
if (failed.length > 0) {
  process.stdout.write(`Failed components: ${failed.map((result) => result.id).join(", ")}\n`);
}
process.stdout.write(`Status: ${overall}\n`);
if (overall !== "passed") process.exitCode = 1;
