#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const artifactRoot = path.join(repoRoot, "artifacts", "typescript", "ts7-beta");
const logsRoot = path.join(artifactRoot, "logs");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const benchmarkCases = [
  {
    id: "repo-typecheck",
    title: "Repo-wide typecheck",
    baseline: {
      id: "ts6",
      title: "TypeScript 6",
      command: pnpmExecutable,
      args: ["typecheck"],
      displayCommand: "pnpm typecheck",
    },
    candidate: {
      id: "ts7",
      title: "TypeScript 7 beta",
      command: pnpmExecutable,
      args: ["ts7:typecheck"],
      displayCommand: "pnpm ts7:typecheck",
    },
  },
  {
    id: "gateway-build",
    title: "Gateway build",
    baseline: {
      id: "ts6",
      title: "TypeScript 6",
      command: pnpmExecutable,
      args: ["--filter", "@goatcitadel/gateway", "build"],
      displayCommand: "pnpm --filter @goatcitadel/gateway build",
    },
    candidate: {
      id: "ts7",
      title: "TypeScript 7 beta",
      command: process.execPath,
      args: [path.join(repoRoot, "scripts", "typescript", "run-ts7-workspace.mjs"), "--mode", "build", "--group", "gateway"],
      displayCommand: "node scripts/typescript/run-ts7-workspace.mjs --mode build --group gateway",
    },
  },
  {
    id: "mission-control-typecheck",
    title: "Mission Control typecheck",
    baseline: {
      id: "ts6",
      title: "TypeScript 6",
      command: pnpmExecutable,
      args: ["--filter", "@goatcitadel/mission-control-next", "typecheck"],
      displayCommand: "pnpm --filter @goatcitadel/mission-control-next typecheck",
    },
    candidate: {
      id: "ts7",
      title: "TypeScript 7 beta",
      command: process.execPath,
      args: [path.join(repoRoot, "scripts", "typescript", "run-ts7-workspace.mjs"), "--mode", "typecheck", "--group", "mission-control-next"],
      displayCommand: "node scripts/typescript/run-ts7-workspace.mjs --mode typecheck --group mission-control-next",
    },
  },
];

async function main() {
  await fs.mkdir(logsRoot, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    experimental: true,
    cases: [],
  };

  try {
    for (const benchmarkCase of benchmarkCases) {
      console.log(`\n[ts7:benchmark] ${benchmarkCase.title}`);
      const result = await runBenchmarkCase(benchmarkCase);
      summary.cases.push(result);
    }

    const output = finalizeSummary(summary);
    await writeSummary(output);
    console.log(`\nTS7 benchmark report written to ${path.relative(repoRoot, artifactRoot)}`);
  } catch (error) {
    const failedSummary = finalizeSummary({
      ...summary,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    await writeSummary(failedSummary);
    throw error;
  }
}

async function runBenchmarkCase(benchmarkCase) {
  const baseline = await runVariantSeries(benchmarkCase, benchmarkCase.baseline);
  const candidate = await runVariantSeries(benchmarkCase, benchmarkCase.candidate);
  const baselineMedianMs = median(baseline.measuredRuns.map((run) => run.durationMs));
  const candidateMedianMs = median(candidate.measuredRuns.map((run) => run.durationMs));
  const deltaPercent = baselineMedianMs === 0 ? 0 : Number((((candidateMedianMs - baselineMedianMs) / baselineMedianMs) * 100).toFixed(2));
  const speedupMultiplier = candidateMedianMs === 0 ? null : Number((baselineMedianMs / candidateMedianMs).toFixed(2));

  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    baseline: {
      ...baseline,
      medianMs: baselineMedianMs,
    },
    candidate: {
      ...candidate,
      medianMs: candidateMedianMs,
    },
    deltaPercent,
    speedupMultiplier,
  };
}

async function runVariantSeries(benchmarkCase, variant) {
  console.log(`  warm-up: ${variant.displayCommand}`);
  const warmup = await runCommand({
    caseId: benchmarkCase.id,
    variant,
    phase: "warmup",
    iteration: 1,
  });

  const measuredRuns = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    console.log(`  run ${iteration}/3: ${variant.displayCommand}`);
    measuredRuns.push(await runCommand({
      caseId: benchmarkCase.id,
      variant,
      phase: "measured",
      iteration,
    }));
  }

  return {
    id: variant.id,
    title: variant.title,
    displayCommand: variant.displayCommand,
    warmup,
    measuredRuns,
  };
}

async function runCommand({ caseId, variant, phase, iteration }) {
  await resetCompilerCaches();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { code, stdout, stderr } = await spawnAndCapture(variant.command, variant.args);
  const durationMs = Number((performance.now() - started).toFixed(2));
  const logPath = path.join(logsRoot, `${caseId}-${variant.id}-${phase}-${iteration}.log`);
  const logLines = [
    `startedAt: ${startedAt}`,
    `command: ${variant.displayCommand}`,
    `exitCode: ${code}`,
    `durationMs: ${durationMs}`,
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
    "",
  ].join("\n");
  await fs.writeFile(logPath, logLines, "utf8");

  if (code !== 0) {
    throw new Error(`${variant.displayCommand} failed with exit code ${code}. See ${path.relative(repoRoot, logPath)}.`);
  }

  return {
    iteration,
    phase,
    startedAt,
    durationMs,
    exitCode: code,
    logPath: path.relative(repoRoot, logPath).replaceAll("\\", "/"),
  };
}

async function resetCompilerCaches() {
  for (const rootName of ["apps", "packages"]) {
    const rootPath = path.join(repoRoot, rootName);
    await removeTsBuildInfoFiles(rootPath);
  }
}

async function removeTsBuildInfoFiles(currentPath) {
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const nextPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }
      await removeTsBuildInfoFiles(nextPath);
      continue;
    }
    if (!entry.name.endsWith(".tsbuildinfo")) {
      continue;
    }
    await fs.rm(nextPath, { force: true });
  }
}

function spawnAndCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function spawnCommand(command, args, options) {
  if (process.platform !== "win32" || !requiresWindowsCommandShell(command)) {
    return spawn(command, args, options);
  }
  const windowsCommand = buildWindowsCommand(command, args);
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsCommand], options);
}

function requiresWindowsCommandShell(command) {
  return /\.(cmd|bat)$/i.test(command);
}

function buildWindowsCommand(command, args) {
  return [quoteWindowsArg(command), ...args.map((value) => quoteWindowsArg(value))].join(" ");
}

function quoteWindowsArg(value) {
  if (value.length === 0) {
    return '""';
  }
  if (!/[ \t"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(2));
  }
  return Number((sorted[middle] ?? 0).toFixed(2));
}

function finalizeSummary(summary) {
  const status = summary.status ?? "success";
  return {
    ...summary,
    status,
  };
}

async function writeSummary(summary) {
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactRoot, "summary.md"), buildMarkdown(summary), "utf8");
}

function buildMarkdown(summary) {
  const lines = [
    "# TypeScript 7 Beta Benchmark",
    "",
    "> Experimental side-by-side benchmark. TS6 remains the default workspace compiler and tooling API target.",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Status: ${summary.status}`,
  ];

  if (summary.error) {
    lines.push(`- Error: ${summary.error}`);
  }

  lines.push("", "| Case | TS6 median | TS7 median | Delta | Speedup |", "| --- | ---: | ---: | ---: | ---: |");

  for (const benchmarkCase of summary.cases ?? []) {
    lines.push(
      `| ${benchmarkCase.title} | ${formatMs(benchmarkCase.baseline?.medianMs)} | ${formatMs(benchmarkCase.candidate?.medianMs)} | ${formatDelta(benchmarkCase.deltaPercent)} | ${formatSpeedup(benchmarkCase.speedupMultiplier)} |`,
    );
  }

  for (const benchmarkCase of summary.cases ?? []) {
    lines.push(
      "",
      `## ${benchmarkCase.title}`,
      "",
      `- TS6 command: \`${benchmarkCase.baseline.displayCommand}\``,
      `- TS7 command: \`${benchmarkCase.candidate.displayCommand}\``,
      `- TS6 runs: ${formatRuns(benchmarkCase.baseline.measuredRuns)}`,
      `- TS7 runs: ${formatRuns(benchmarkCase.candidate.measuredRuns)}`,
      `- Delta: ${formatDelta(benchmarkCase.deltaPercent)}`,
      `- Speedup: ${formatSpeedup(benchmarkCase.speedupMultiplier)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatRuns(runs) {
  return (runs ?? []).map((run) => `${run.durationMs}ms`).join(", ");
}

function formatMs(value) {
  return `${Number(value ?? 0).toFixed(2)}ms`;
}

function formatDelta(value) {
  const numeric = Number(value ?? 0).toFixed(2);
  return `${numeric}%`;
}

function formatSpeedup(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return `${Number(value).toFixed(2)}x`;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
