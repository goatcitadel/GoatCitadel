import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createVerificationRunManifest,
  validateVerificationRepairPlan,
  validateVerificationReview,
} from "./validation.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
export const artifactsRoot = path.join(repoRoot, "artifacts", "verification");
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";
const COMMAND_SUMMARY_CAPTURE_BYTES = 256 * 1024;
export const FAST_LANE_PERF_ARTIFACT = "perf/fast-lane-timing.json";
const FAST_LANE_PERF_BUDGETS = Object.freeze({
  total: { warnMs: 240_000, failMs: 300_000 },
  "fast.test": { warnMs: 135_000 },
  "fast.smoke": { warnMs: 45_000 },
});
// Scenario timestamps and durations are sampled by adjacent clock calls. Permit
// only a small scheduling gap before treating the wall-clock interval as untrusted.
const FAST_LANE_INTERVAL_CLOCK_TOLERANCE_MS = 250;

export function createRunId(lane) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${lane}-${randomUUID().slice(0, 8)}`;
}

export async function createRunContext(lane, options = {}) {
  const runId = options.runId || createRunId(lane);
  const artifactRoot = path.join(artifactsRoot, runId);
  const manifest = createVerificationRunManifest({
    runId,
    lane,
    startedAt: new Date().toISOString(),
    repoRoot,
    artifactRoot,
    metadata: {
      profile: options.profile ?? "local",
      includeSoak: options.includeSoak ?? false,
      durationMs: options.durationMs,
      // Set when the run was asked for a slice of a lane rather than all of it.
      // The lane-wide perf budgets cannot be judged from one slice.
      ...(options.commandSelection ? { commandSelection: options.commandSelection } : {}),
    },
  });

  await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });
  await fs.mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });
  await fs.mkdir(path.join(artifactRoot, "playwright"), { recursive: true });
  await fs.mkdir(path.join(artifactRoot, "provider-results"), { recursive: true });
  await fs.mkdir(path.join(artifactRoot, "perf"), { recursive: true });
  await writeJson(path.join(artifactRoot, "manifest.json"), manifest);
  await writeJson(path.join(artifactsRoot, "latest-run.json"), {
    runId,
    artifactRoot,
    startedAt: manifest.startedAt,
  });

  return {
    lane,
    options,
    repoRoot,
    runId,
    artifactRoot,
    manifest,
  };
}

export async function finalizeRunContext(context, statusOverride) {
  await flushManifestWrites(context);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(context.manifest.startedAt);
  const baseManifest = createVerificationRunManifest({
    ...context.manifest,
    finishedAt,
    durationMs,
    status: statusOverride ?? deriveManifestStatus(context.manifest),
  });
  // A sliced run holds only part of the lane, so its timings cannot be measured
  // against the lane's budgets — most slices record no fast.test scenario at all,
  // which the budget reads as a missing measurement. merge-fast-manifests.mjs
  // evaluates the budgets once the parts are recomposed into a whole run.
  const partialRun = typeof baseManifest.metadata?.commandSelection === "string";
  const fastLanePerf =
    baseManifest.lane === "fast" && !partialRun ? await writeFastLanePerfArtifact(context, baseManifest) : undefined;
  const finalStatus =
    statusOverride ??
    (fastLanePerf?.integrityFailure || (fastLanePerf?.strict && fastLanePerf.status === "failed")
      ? "failed"
      : deriveManifestStatus(context.manifest));
  const finalManifest = createVerificationRunManifest({
    ...baseManifest,
    status: finalStatus,
    metadata: {
      ...baseManifest.metadata,
      ...(fastLanePerf
        ? {
            fastLanePerf: {
              artifact: FAST_LANE_PERF_ARTIFACT,
              status: fastLanePerf.status,
              strict: fastLanePerf.strict,
              integrityFailure: fastLanePerf.integrityFailure,
            },
          }
        : {}),
    },
  });
  context.manifest = finalManifest;
  await writeManifest(context, finalManifest);
  await writeText(path.join(context.artifactRoot, "summary.md"), buildSummaryMarkdown(finalManifest));
  await writeText(path.join(context.artifactRoot, "junit.xml"), buildJunitXml(finalManifest));
  return finalManifest;
}

export async function recordScenario(context, scenario) {
  const parsed = {
    notes: [],
    metrics: {},
    artifacts: {
      diagnostics: [],
      screenshots: [],
      traces: [],
      logs: [],
      perf: [],
      playwright: [],
    },
    ...scenario,
  };
  context.manifest = createVerificationRunManifest({
    ...context.manifest,
    scenarios: [...context.manifest.scenarios, parsed],
    counts: tallyScenarioCounts([...context.manifest.scenarios, parsed]),
  });
  await writeManifest(context, context.manifest);
  return parsed;
}

async function writeManifest(context, manifest) {
  const manifestPath = path.join(context.artifactRoot, "manifest.json");
  context.manifestWritePromise = (context.manifestWritePromise ?? Promise.resolve()).then(() =>
    writeJson(manifestPath, manifest),
  );
  await context.manifestWritePromise;
}

async function flushManifestWrites(context) {
  if (context.manifestWritePromise) {
    await context.manifestWritePromise;
  }
}

export async function runScenario(context, definition, fn) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const correlationId = definition.correlationId ?? `verify-${randomUUID()}`;
  try {
    const result = await fn({ correlationId });
    return await recordScenario(context, {
      id: definition.id,
      lane: definition.lane ?? context.lane,
      title: definition.title,
      subsystem: definition.subsystem,
      status: result?.status ?? "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      correlationId,
      providerId: result?.providerId,
      modelId: result?.modelId,
      notes: result?.notes ?? [],
      error: result?.error,
      metrics: result?.metrics ?? {},
      artifacts: result?.artifacts ?? {
        diagnostics: [],
        screenshots: [],
        traces: [],
        logs: [],
        perf: [],
        playwright: [],
      },
    });
  } catch (error) {
    return await recordScenario(context, {
      id: definition.id,
      lane: definition.lane ?? context.lane,
      title: definition.title,
      subsystem: definition.subsystem,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      correlationId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      notes: [],
      metrics: {},
      artifacts: {
        diagnostics: [],
        screenshots: [],
        traces: [],
        logs: [],
        perf: [],
        playwright: [],
      },
    });
  }
}

export async function runCommand(command, args, options = {}) {
  const startedAt = Date.now();
  const logName = options.logName ?? sanitizeFilePart(`${command}-${args.join("-")}`);
  const stdoutPath = options.stdoutPath ?? path.join(options.artifactRoot ?? artifactsRoot, `${logName}.stdout.log`);
  const stderrPath = options.stderrPath ?? path.join(options.artifactRoot ?? artifactsRoot, `${logName}.stderr.log`);
  await fs.mkdir(path.dirname(stdoutPath), { recursive: true });
  await fs.mkdir(path.dirname(stderrPath), { recursive: true });
  const tempDir = await ensureShortVerificationTempDir(options.tempDir);

  return await new Promise((resolve, reject) => {
    const stdoutCapture = createBoundedCapture(COMMAND_SUMMARY_CAPTURE_BYTES);
    const stderrCapture = createBoundedCapture(COMMAND_SUMMARY_CAPTURE_BYTES);
    const stdoutStream = createWriteStream(stdoutPath);
    const stderrStream = createWriteStream(stderrPath);
    const child = spawnVerificationProcess(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputPipelineError;
    const outputPipelines = Promise.all([
      pipeline(child.stdout, createCaptureTransform(stdoutCapture), stdoutStream),
      pipeline(child.stderr, createCaptureTransform(stderrCapture), stderrStream),
    ]).catch((error) => {
      outputPipelineError = error;
    });

    child.on("error", (error) => {
      stdoutStream.destroy();
      stderrStream.destroy();
      reject(error);
    });
    child.on("close", async (code) => {
      await outputPipelines;
      if (outputPipelineError) {
        reject(outputPipelineError);
        return;
      }
      resolve({
        code: code ?? 0,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        durationMs: Date.now() - startedAt,
        stdoutPath,
        stderrPath,
      });
    });
  });
}

async function ensureShortVerificationTempDir(requestedTempDir) {
  if (requestedTempDir) {
    await fs.mkdir(requestedTempDir, { recursive: true });
    return requestedTempDir;
  }
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempDir = path.join(base, `gcv-${process.pid}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

function createBoundedCapture(maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  return {
    append(value) {
      const chunk = Buffer.from(value);
      if (chunk.byteLength >= maxBytes) {
        chunks.length = 0;
        chunks.push(chunk.subarray(chunk.byteLength - maxBytes));
        totalBytes = maxBytes;
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      while (totalBytes > maxBytes && chunks.length > 0) {
        const first = chunks[0];
        const overage = totalBytes - maxBytes;
        if (first.byteLength <= overage) {
          chunks.shift();
          totalBytes -= first.byteLength;
        } else {
          chunks[0] = first.subarray(overage);
          totalBytes -= overage;
        }
      }
    },
    toString() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function createCaptureTransform(capture) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      capture.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback(null, chunk);
    },
  });
}

export function spawnVerificationProcess(command, args, options = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawn(WINDOWS_CMD_PATH, ["/d", "/s", "/c", command, ...args], options);
  }
  return spawn(command, args, options);
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

export async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
  return filePath;
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export function sanitizeFilePart(value) {
  return value
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function formatDuration(durationMs) {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  const seconds = Math.round(durationMs / 100) / 10;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round((seconds % 60) * 10) / 10;
  return `${minutes}m ${remainderSeconds.toFixed(1)}s`;
}

export function clampString(value, maxLength = 500) {
  if (!value) {
    return "";
  }
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export function deriveManifestStatus(manifest) {
  if (manifest.counts.failed > 0) {
    return "failed";
  }
  if (manifest.counts.degraded > 0) {
    return "degraded";
  }
  return "passed";
}

export function tallyScenarioCounts(scenarios) {
  return scenarios.reduce(
    (counts, item) => {
      if (item.status === "passed") {
        counts.passed += 1;
      } else if (item.status === "failed") {
        counts.failed += 1;
      } else if (item.status === "skipped") {
        counts.skipped += 1;
      } else if (item.status === "degraded") {
        counts.degraded += 1;
      } else if (item.status === "not_configured") {
        counts.notConfigured += 1;
      }
      return counts;
    },
    {
      passed: 0,
      failed: 0,
      skipped: 0,
      degraded: 0,
      notConfigured: 0,
    },
  );
}

export function buildSummaryMarkdown(manifest) {
  const fastLanePerf = manifest.metadata?.fastLanePerf;
  const lines = [
    `# Verification Run ${manifest.runId}`,
    "",
    `- Lane: \`${manifest.lane}\``,
    `- Status: \`${manifest.status}\``,
    `- Started: ${manifest.startedAt}`,
    `- Finished: ${manifest.finishedAt ?? "running"}`,
    `- Duration: ${typeof manifest.durationMs === "number" ? formatDuration(manifest.durationMs) : "n/a"}`,
    "",
    "## Counts",
    "",
    `- Passed: ${manifest.counts.passed}`,
    `- Failed: ${manifest.counts.failed}`,
    `- Degraded: ${manifest.counts.degraded}`,
    `- Skipped: ${manifest.counts.skipped}`,
    `- Not configured: ${manifest.counts.notConfigured}`,
    "",
    ...(fastLanePerf
      ? [
          "## Fast Lane Performance",
          "",
          `- Budget status: \`${fastLanePerf.status}\`${
            fastLanePerf.integrityFailure
              ? " (measurement integrity failure; enforced)"
              : fastLanePerf.strict
                ? " (strict)"
                : " (not enforced)"
          }`,
          `- Timing artifact: \`${fastLanePerf.artifact}\``,
          "",
        ]
      : []),
    "## Scenarios",
    "",
    "| ID | Subsystem | Status | Duration | Notes |",
    "| --- | --- | --- | ---: | --- |",
    ...manifest.scenarios.map(
      (item) =>
        `| ${item.id} | ${item.subsystem} | ${item.status} | ${formatDuration(item.durationMs)} | ${escapeTable(item.notes.join("; ") || item.error || "")} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function writeFastLanePerfArtifact(context, manifest) {
  const strict =
    String(process.env.GOATCITADEL_VERIFY_PERF_BUDGET ?? "")
      .trim()
      .toLowerCase() === "strict";
  const payload = buildFastLanePerfPayload(manifest, { strict });
  await writeJson(path.join(context.artifactRoot, FAST_LANE_PERF_ARTIFACT), payload);
  return { status: payload.status, strict, integrityFailure: payload.integrityFailure };
}

export function buildFastLanePerfPayload(manifest, options = {}) {
  const strict = options.strict === true;
  const scenarioTimings = manifest.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    status: scenario.status,
    startedAt: scenario.startedAt,
    finishedAt: scenario.finishedAt,
    durationMs: scenario.durationMs,
  }));
  const fastTestTiming = deriveFastTestTiming(scenarioTimings, manifest);
  const fastTestBudget = {
    ...evaluatePerfBudget("fast.test", fastTestTiming.durationMs, FAST_LANE_PERF_BUDGETS["fast.test"]),
    calculation: fastTestTiming.calculation,
    integrityFailure: fastTestTiming.integrityFailure === true,
    ...(fastTestTiming.integrityFailure
      ? {
          status: "failed",
          reason: fastTestTiming.failureReason,
        }
      : {}),
  };
  const budgets = [
    evaluatePerfBudget("total", manifest.durationMs ?? 0, FAST_LANE_PERF_BUDGETS.total),
    fastTestBudget,
    evaluatePerfBudget(
      "fast.smoke",
      scenarioTimings.find((scenario) => scenario.id === "fast.smoke")?.durationMs ?? 0,
      FAST_LANE_PERF_BUDGETS["fast.smoke"],
    ),
  ];
  const status = derivePerfBudgetStatus(budgets);
  return {
    generatedAt: new Date().toISOString(),
    runId: manifest.runId,
    lane: manifest.lane,
    strict,
    status,
    integrityFailure: fastTestTiming.integrityFailure === true,
    budgets,
    scenarios: scenarioTimings,
  };
}

function deriveFastTestTiming(scenarioTimings, manifest) {
  const testTimings = scenarioTimings.filter(
    (scenario) => scenario.id === "fast.test" || scenario.id.startsWith("fast.test."),
  );
  if (testTimings.length === 0) {
    return {
      durationMs: 0,
      calculation: "missing_scenarios",
      integrityFailure: true,
      failureReason: "No fast.test scenarios were recorded.",
    };
  }

  const invalidDurationScenario = testTimings.find(
    (scenario) => !Number.isFinite(scenario.durationMs) || scenario.durationMs < 0,
  );
  if (invalidDurationScenario) {
    return {
      durationMs: 0,
      calculation: "invalid_scenario_duration",
      integrityFailure: true,
      failureReason: `Fast test scenario ${invalidDurationScenario.id} has an invalid durationMs.`,
    };
  }

  const durationSumMs = testTimings.reduce((sum, scenario) => sum + scenario.durationMs, 0);
  const intervals = testTimings.map((scenario) => {
    const startedAtMs = typeof scenario.startedAt === "string" ? Date.parse(scenario.startedAt) : Number.NaN;
    const finishedAtMs = typeof scenario.finishedAt === "string" ? Date.parse(scenario.finishedAt) : Number.NaN;
    return { startedAtMs, finishedAtMs, durationMs: scenario.durationMs };
  });
  const runStartedAtMs = typeof manifest.startedAt === "string" ? Date.parse(manifest.startedAt) : Number.NaN;
  const runFinishedAtMs = typeof manifest.finishedAt === "string" ? Date.parse(manifest.finishedAt) : Number.NaN;
  const hasValidRunBounds =
    Number.isFinite(runStartedAtMs) && Number.isFinite(runFinishedAtMs) && runFinishedAtMs >= runStartedAtMs;
  const hasCompleteIntervals =
    hasValidRunBounds &&
    intervals.every(
      ({ startedAtMs, finishedAtMs, durationMs }) =>
        Number.isFinite(startedAtMs) &&
        Number.isFinite(finishedAtMs) &&
        Number.isFinite(durationMs) &&
        durationMs >= 0 &&
        finishedAtMs >= startedAtMs &&
        startedAtMs >= runStartedAtMs &&
        finishedAtMs <= runFinishedAtMs &&
        Math.abs(finishedAtMs - startedAtMs - durationMs) <= FAST_LANE_INTERVAL_CLOCK_TOLERANCE_MS,
    );
  if (!hasCompleteIntervals) {
    return { durationMs: durationSumMs, calculation: "scenario_duration_sum" };
  }

  const earliestStartMs = Math.min(...intervals.map(({ startedAtMs }) => startedAtMs));
  const latestFinishMs = Math.max(...intervals.map(({ finishedAtMs }) => finishedAtMs));
  return {
    durationMs: latestFinishMs - earliestStartMs,
    calculation: "test_phase_elapsed",
  };
}

function evaluatePerfBudget(id, durationMs, budget) {
  const failMs = budget.failMs;
  const warnMs = budget.warnMs;
  const status =
    typeof failMs === "number" && durationMs > failMs
      ? "failed"
      : typeof warnMs === "number" && durationMs > warnMs
        ? "warn"
        : "passed";
  return {
    id,
    durationMs,
    warnMs,
    failMs,
    status,
  };
}

function derivePerfBudgetStatus(budgets) {
  if (budgets.some((budget) => budget.status === "failed")) {
    return "failed";
  }
  if (budgets.some((budget) => budget.status === "warn")) {
    return "warn";
  }
  return "passed";
}

export function buildJunitXml(manifest) {
  const testcases = manifest.scenarios.map((item) => {
    const durationSeconds = (item.durationMs / 1000).toFixed(3);
    const name = escapeXml(item.title);
    const classname = escapeXml(item.subsystem);
    if (item.status === "failed") {
      return `    <testcase classname="${classname}" name="${name}" time="${durationSeconds}"><failure message="${escapeXml(item.error || "verification failed")}">${escapeXml(item.error || "verification failed")}</failure></testcase>`;
    }
    if (item.status === "skipped" || item.status === "not_configured") {
      return `    <testcase classname="${classname}" name="${name}" time="${durationSeconds}"><skipped message="${escapeXml(item.status)}" /></testcase>`;
    }
    return `    <testcase classname="${classname}" name="${name}" time="${durationSeconds}" />`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="goatcitadel-verification" tests="${manifest.scenarios.length}" failures="${manifest.counts.failed}" skipped="${manifest.counts.skipped + manifest.counts.notConfigured}" time="${((manifest.durationMs ?? 0) / 1000).toFixed(3)}">`,
    ...testcases,
    "</testsuite>",
    "",
  ].join("\n");
}

function escapeTable(value) {
  return clampString(value.replace(/\r?\n+/g, " "), 180)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function parseCliArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.split("=", 2);
    const key = rawKey.slice(2);
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { positional, options };
}

export function maybeParseInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function maybeParseBool(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function parseLatestRunPointer(pointer) {
  if (!pointer?.artifactRoot) {
    throw new Error("Latest verification run pointer is invalid.");
  }
  return pointer;
}

export function validateReviewPayload(review) {
  return validateVerificationReview(review);
}

export function validateRepairPlanPayload(plan) {
  return validateVerificationRepairPlan(plan);
}
