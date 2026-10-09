import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GATEWAY_COVERAGE_SHARD_COUNT, STORAGE_COVERAGE_SHARD_COUNT, gatewayCoverageShardDirectory } from "../../../coverage-shard-contract.mjs";
import { clampString, maybeParseBool, repoRoot, runCommand, runScenario, sanitizeFilePart } from "../shared.mjs";
import { prepareVerificationRuntime } from "../runtime.mjs";
import {
  DEFAULT_CHANGED_BASE_REF,
  collectChangedPaths,
  describeChangedFastLanePlan,
  planChangedFastLane,
  readWorkspacePackages,
} from "./fast-lane-changed.mjs";
// The lane runs each package's `test:coverage` script rather than `test` so the
// production coverage gate can aggregate what this run already measured instead of
// executing every suite a second time. Instrumentation is close to free here
// (gateway +6%, storage faster because its coverage script runs compiled output),
// while the second full pass cost the pipeline roughly seventeen minutes.
const FAST_LANE_TEMP_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const FAST_LANE_SAFE_TEST_CONCURRENCY = 2;
// The gateway suite is 860 files and was the lane's single longest scenario at
// roughly eight and a half minutes. Sharding only pays off across machines, so the
// shards run serially in a local lane and one-per-job in CI.
const FAST_LANE_VITEST_MAX_WORKERS = 4;
// UI and recursive library coverage share one stage. Bound the whole stage to
// four test workers: two for UI plus one per concurrently running library.
const FAST_LANE_UI_VITEST_MAX_WORKERS = 2;
const FAST_LANE_LIBRARY_VITEST_MAX_WORKERS = 1;
// Overlap is opt-in. On a hard-disk Windows host (2026-10-08) running the gateway
// and storage tracks together, with two storage shards side by side, made module
// imports ~17x slower and turned 140+ tests into timeouts: the suites contend for
// disk, not CPU. Enable it with GOATCITADEL_VERIFY_FAST_TRACKS=1 and
// GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY=2 on SSD hosts. Storage shards never
// overlap while a live PostgreSQL is configured: those tests share one server and
// their setup and cleanup must not race.
const FAST_LANE_STORAGE_SHARD_CONCURRENCY = 1;
export const FAST_LANE_TRACKS_ENV = "GOATCITADEL_VERIFY_FAST_TRACKS";
export const FAST_LANE_STORAGE_SHARD_CONCURRENCY_ENV = "GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY";
const STORAGE_TEST_POSTGRES_URL_ENV = "GOATCITADEL_TEST_POSTGRES_URL";
const GATEWAY_TEST_SHARDS = Object.freeze(
  Array.from({ length: GATEWAY_COVERAGE_SHARD_COUNT }, (_unused, index) => index + 1),
);
const STORAGE_TEST_SHARDS = Object.freeze(
  Array.from({ length: STORAGE_COVERAGE_SHARD_COUNT }, (_unused, index) => index + 1),
);
export const FAST_LANE_LIBRARY_TEST_FILTERS = Object.freeze([
  "@goatcitadel/contracts",
  "@goatcitadel/extensions-sdk",
  "@goatcitadel/gateway-core",
  "@goatcitadel/memory-core",
  "@goatcitadel/mesh-core",
  "@goatcitadel/mission-control-desktop",
  "@goatcitadel/mission-control-shared",
  "@goatcitadel/orchestration",
  "@goatcitadel/skills",
  "@goatcitadel/threaded-surface-core",
]);

export const FAST_LANE_COMMANDS = Object.freeze([
  { id: "fast.skills-catalog", title: "Skill catalog coverage", args: ["verify:skills:catalog"] },
  { id: "fast.repo-hygiene", title: "Repo hygiene", args: ["verify:repo:hygiene"] },
  { id: "fast.storage-migration-parity", title: "Storage migration parity", args: ["verify:storage:migration-parity"] },
  {
    id: "fast.extensions-sdk-build",
    title: "Extensions SDK build",
    args: ["--filter", "@goatcitadel/extensions-sdk", "build"],
  },
  {
    id: "fast.extensions-sdk-package",
    title: "Extensions SDK package artifact",
    args: ["verify:extensions:package:from-build"],
  },
  { id: "fast.typecheck", title: "Root typecheck", args: ["typecheck"] },
  ...GATEWAY_TEST_SHARDS.map((shard) => ({
    id: `fast.test.gateway.shard${shard}`,
    title: `Gateway tests (shard ${shard}/${GATEWAY_COVERAGE_SHARD_COUNT})`,
    args: [
      "--filter",
      "@goatcitadel/gateway",
      "test:coverage:vitest",
      // No `--` separator: pnpm forwards that literally, and vitest then reads the
      // shard flag as a positional filter and silently runs the whole suite.
      `--shard=${shard}/${GATEWAY_COVERAGE_SHARD_COUNT}`,
      // Each shard needs its own report directory. The collector discovers any
      // `coverage*` directory, so the shards merge without further wiring.
      `--coverage.reportsDirectory=${gatewayCoverageShardDirectory(shard)}`,
      // Vitest otherwise uses availableParallelism()-1 workers. That overloaded
      // high-core Windows hosts with concurrent SQLite/filesystem setup and turned
      // unrelated 15-second tests into false failures under coverage.
      `--maxWorkers=${FAST_LANE_VITEST_MAX_WORKERS}`,
    ],
    // File-backed Gateway fixtures can reuse the same opt-in schema template
    // as the storage lane. Every database still validates its migration ledger.
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1", GOATCITADEL_SQLITE_SCHEMA_TEMPLATE: "1" },
  })),
  {
    id: "fast.test.gateway.node",
    title: "Gateway node-runner tests",
    args: ["--filter", "@goatcitadel/gateway", "test:node"],
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  },
  {
    id: "fast.coverage.gateway.smoke",
    title: "Gateway smoke coverage",
    args: ["--filter", "@goatcitadel/gateway", "coverage:smoke"],
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  },
  {
    id: "fast.coverage.gateway.exercise",
    title: "Gateway exercise coverage",
    args: ["--filter", "@goatcitadel/gateway", "coverage:exercise"],
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  },
  ...STORAGE_TEST_SHARDS.map((shard) => ({
    id: `fast.test.storage.shard${shard}`,
    title: `Storage tests (shard ${shard}/${STORAGE_COVERAGE_SHARD_COUNT})`,
    args: ["--filter", "@goatcitadel/storage", "test:coverage", `--shard=${shard}/${STORAGE_COVERAGE_SHARD_COUNT}`],
    // The suite creates ~1,200 SQLite databases and replaying the migration
    // registry costs ~600ms each, which was about two thirds of this scenario.
    // The template snapshots the migrated schema once per process; the ledger is
    // still validated on every database. Shards reuse the build produced by the
    // stage's prepare step instead of each cleaning and rebuilding `dist`.
    env: { GOATCITADEL_SQLITE_SCHEMA_TEMPLATE: "1", GOATCITADEL_STORAGE_COVERAGE_PREBUILT: "1" },
  })),
  {
    id: "fast.test.mission-control-next",
    title: "Mission Control Next tests",
    args: [
      "--filter",
      "@goatcitadel/mission-control-next",
      "test:coverage",
      `--maxWorkers=${FAST_LANE_UI_VITEST_MAX_WORKERS}`,
    ],
  },
  {
    id: "fast.test.policy-engine",
    title: "Policy engine tests",
    // Match the Gateway worker budget: policy coverage also performs real
    // filesystem and Git operations on high-core Windows hosts.
    args: ["--filter", "@goatcitadel/policy-engine", "test:coverage", `--maxWorkers=${FAST_LANE_VITEST_MAX_WORKERS}`],
  },
  {
    id: "fast.test.libraries",
    title: "Library and desktop tests",
    args: [
      ...FAST_LANE_LIBRARY_TEST_FILTERS.flatMap((filter) => ["--filter", filter]),
      "-r",
      "--workspace-concurrency=2",
      "test:coverage",
      `--maxWorkers=${FAST_LANE_LIBRARY_VITEST_MAX_WORKERS}`,
    ],
  },
  {
    id: "fast.smoke",
    title: "Gateway smoke (fast profile)",
    args: ["smoke", "--", "--profile", "fast"],
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  },
  { id: "fast.build", title: "Root build", args: ["build"] },
  { id: "fast.docs", title: "Docs checks", args: ["docs:check"] },
  {
    id: "fast.gateway-async-boundary",
    title: "Gateway async boundary",
    args: ["verify:gateway:async-boundary"],
  },
]);

export const FAST_LANE_STAGES = Object.freeze([
  {
    id: "fast.prerequisites",
    mode: "serial",
    commands: [
      "fast.skills-catalog",
      "fast.repo-hygiene",
      "fast.storage-migration-parity",
      "fast.extensions-sdk-build",
      "fast.extensions-sdk-package",
      "fast.typecheck",
    ],
  },
  {
    // Gateway and storage tests share no output, so on hosts with fast disks the
    // two tracks can overlap (GOATCITADEL_VERIFY_FAST_TRACKS=1) and the lane waits
    // only for the slower one. By default they run one after the other.
    id: "fast.tests",
    mode: "tracks",
    tracks: [
      {
        id: "fast.track.gateway",
        stages: [
          {
            id: "fast.test.gateway",
            mode: "serial",
            commands: [...GATEWAY_TEST_SHARDS.map((shard) => `fast.test.gateway.shard${shard}`), "fast.test.gateway.node"],
          },
          {
            id: "fast.coverage.gateway",
            mode: "serial",
            commands: ["fast.coverage.gateway.smoke", "fast.coverage.gateway.exercise"],
          },
        ],
      },
      {
        id: "fast.track.storage-and-ui",
        stages: [
          {
            id: "fast.test.storage",
            mode: "parallel",
            concurrency: FAST_LANE_STORAGE_SHARD_CONCURRENCY,
            concurrencyEnv: FAST_LANE_STORAGE_SHARD_CONCURRENCY_ENV,
            serialWhenEnv: STORAGE_TEST_POSTGRES_URL_ENV,
            prepare: {
              id: "fast.test.storage.build",
              title: "Storage build for coverage shards",
              args: ["--filter", "@goatcitadel/storage", "test:coverage", "--build-only"],
            },
            commands: STORAGE_TEST_SHARDS.map((shard) => `fast.test.storage.shard${shard}`),
          },
          {
            id: "fast.test.policy-engine",
            mode: "serial",
            commands: ["fast.test.policy-engine"],
          },
          {
            id: "fast.test.safe-parallel",
            mode: "parallel",
            concurrency: FAST_LANE_SAFE_TEST_CONCURRENCY,
            commands: ["fast.test.mission-control-next", "fast.test.libraries"],
          },
        ],
      },
    ],
  },
  {
    id: "fast.post-tests",
    mode: "serial",
    commands: ["fast.smoke", "fast.build", "fast.docs", "fast.gateway-async-boundary"],
  },
]);

const FAST_LANE_COMMAND_BY_ID = new Map(FAST_LANE_COMMANDS.map((command) => [command.id, command]));

export const A2A_FULL_LANE_COMMANDS = Object.freeze([
  {
    id: "a2a-full.contracts-build",
    title: "A2A contracts build",
    args: ["--filter", "@goatcitadel/contracts", "build"],
  },
  {
    id: "a2a-full.storage-build",
    title: "A2A storage build",
    args: ["--filter", "@goatcitadel/storage", "build"],
  },
  {
    id: "a2a-full.storage-migration-parity",
    title: "A2A storage migration parity",
    args: ["verify:storage:migration-parity"],
  },
  {
    id: "a2a-full.mission-control-shared-build",
    title: "A2A Mission Control shared build",
    args: ["--filter", "@goatcitadel/mission-control-shared", "build"],
  },
  {
    id: "a2a-full.gateway-typecheck",
    title: "Gateway A2A typecheck",
    args: ["--filter", "@goatcitadel/gateway", "typecheck"],
  },
  {
    id: "a2a-full.gateway-routes",
    title: "Gateway A2A route and service tests",
    args: [
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "src/services/a2a-grpc-service.test.ts",
      "src/services/a2a-route-service.test.ts",
      "src/routes/tasks.test.ts",
    ],
  },
]);

/**
 * Resolves a `--commands=a,b,c` selection into the command ids to run. An empty
 * selection means "the whole lane", which keeps `pnpm verify:fast` unchanged. An
 * unrecognised or empty-after-filtering id is an error rather than a silent no-op:
 * a shard that quietly runs nothing would report success and take its share of the
 * lane's coverage with it.
 */
export function resolveFastLaneSelection(raw) {
  const requested = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (requested.length === 0) {
    return undefined;
  }
  const unknown = requested.filter((id) => !FAST_LANE_COMMAND_BY_ID.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown fast lane command id(s): ${unknown.join(", ")}. Known ids: ` +
        `${FAST_LANE_COMMANDS.map((command) => command.id).join(", ")}.`,
    );
  }
  return new Set(requested);
}

/**
 * Plans a `--changed[=<ref>]` run: only the package test commands whose package,
 * or a workspace dependency of it, changed since the merge base with `ref`.
 * Prerequisites and whole-repo checks always run. Returns `undefined` selection
 * for the whole lane when a root-level change can affect every suite.
 */
export function resolveChangedFastLaneRun(rawRef, deps = {}) {
  const baseRef = typeof rawRef === "string" && rawRef.trim() ? rawRef.trim() : DEFAULT_CHANGED_BASE_REF;
  const plan = planChangedFastLane({
    changedPaths: (deps.collectChangedPaths ?? collectChangedPaths)(repoRoot, baseRef),
    packages: (deps.readWorkspacePackages ?? readWorkspacePackages)(repoRoot),
    commandIds: FAST_LANE_COMMANDS.map((command) => command.id),
    libraryPackages: FAST_LANE_LIBRARY_TEST_FILTERS,
  });
  const summary = describeChangedFastLanePlan(plan, baseRef);
  if (plan.fullLane) {
    // A root-level change runs the whole lane, which is a complete run.
    return { baseRef, plan, summary, selection: undefined, commandSelection: undefined };
  }
  return {
    baseRef,
    plan,
    summary,
    selection: plan.selection,
    commandSelection: `changed:${baseRef}:${[...plan.selection].join(",")}`,
  };
}

/** Every command id a stage schedules, including the stages nested in its tracks. */
export function fastLaneStageCommandIds(stage) {
  if (stage.mode === "tracks") {
    return stage.tracks.flatMap((track) => track.stages.flatMap(fastLaneStageCommandIds));
  }
  return [...stage.commands];
}

export function selectFastLaneStages(stages, selection) {
  if (!selection) {
    return stages;
  }
  const selected = filterFastLaneStages(stages, selection);
  const scheduled = new Set(selected.flatMap(fastLaneStageCommandIds));
  const dropped = [...selection].filter((id) => !scheduled.has(id));
  if (dropped.length > 0) {
    throw new Error(`Fast lane command id(s) not scheduled by any stage: ${dropped.join(", ")}.`);
  }
  return selected;
}

function filterFastLaneStages(stages, selection) {
  return stages
    .map((stage) => {
      if (stage.mode !== "tracks") {
        return { ...stage, commands: stage.commands.filter((id) => selection.has(id)) };
      }
      const tracks = stage.tracks
        .map((track) => ({ ...track, stages: filterFastLaneStages(track.stages, selection) }))
        .filter((track) => track.stages.length > 0);
      return { ...stage, tracks };
    })
    .filter((stage) => (stage.mode === "tracks" ? stage.tracks.length > 0 : stage.commands.length > 0));
}

/**
 * Serial execution keeps the stage order and every prepare step but runs one
 * command at a time: tracks run one after another and parallel stages run serially.
 */
export function serializeFastLaneStages(stages) {
  return stages.flatMap((stage) =>
    stage.mode === "tracks"
      ? serializeFastLaneStages(stage.tracks.flatMap((track) => track.stages))
      : [{ ...stage, mode: "serial", concurrency: undefined }],
  );
}

/**
 * A parallel stage's effective width. `serialWhenEnv` forces one-at-a-time when
 * that variable is set (live PostgreSQL), and `concurrencyEnv` lets an operator
 * lower or raise the width without editing the plan.
 */
export function resolveFastLaneStageConcurrency(stage, environment = process.env) {
  if (stage.mode !== "parallel") return 1;
  if (stage.serialWhenEnv && String(environment[stage.serialWhenEnv] ?? "").trim()) return 1;
  const override = stage.concurrencyEnv ? Number.parseInt(String(environment[stage.concurrencyEnv] ?? ""), 10) : Number.NaN;
  if (Number.isInteger(override) && override >= 1) return override;
  return stage.concurrency ?? 1;
}

export async function runFastLane(context, options = {}) {
  const failFast = maybeParseBool(options.failFast ?? process.env.GOATCITADEL_VERIFY_FAIL_FAST, false);
  const serial = failFast || maybeParseBool(options.serial ?? process.env.GOATCITADEL_VERIFY_SERIAL, false);
  const concurrentTracks = !serial && maybeParseBool(options.tracks ?? process.env[FAST_LANE_TRACKS_ENV], false);
  const injectedFailureScenario =
    typeof options.injectFailureScenario === "string" ? options.injectFailureScenario : undefined;
  const executionOptions = {
    failFast,
    injectFailureScenario: injectedFailureScenario,
    concurrentTracks,
    // Injectable so the scheduler can be tested without spawning real suites.
    runCommand: options.runCommand ?? runCommand,
  };
  const selection = options.selection ?? resolveFastLaneSelection(options.commands ?? process.env.GOATCITADEL_VERIFY_FAST_COMMANDS);
  const selectedStages = selectFastLaneStages(FAST_LANE_STAGES, selection);
  await runFastLaneStages(context, serial ? serializeFastLaneStages(selectedStages) : selectedStages, executionOptions);
}

async function runFastLaneStages(context, stages, options) {
  for (const stage of stages) {
    await runFastLaneStage(context, stage, options);
  }
}

async function runFastLaneStage(context, stage, options) {
  if (stage.mode === "tracks") {
    const tracks = await prepareFastLaneTracks(context, stage.tracks, options);
    if (!options.concurrentTracks) {
      for (const track of tracks) await runFastLaneStages(context, track.stages, options);
      return;
    }
    const outcomes = await Promise.allSettled(tracks.map((track) => runFastLaneStages(context, track.stages, options)));
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected) throw rejected.reason;
    return;
  }
  if (stage.prepare && !(await runFastLaneStagePrepare(context, stage, options))) {
    return;
  }
  if (stage.mode === "parallel") {
    await runFastLaneParallelStage(context, stage, options);
    return;
  }
  await runFastLaneSerialStage(context, stage, options);
}

/**
 * Runs every nested prepare step before the tracks fork. The storage prepare
 * deletes and rebuilds `packages/storage/dist`, which gateway smoke and node
 * tests resolve through the package export map; doing it while the gateway
 * track runs would race them. A stage whose prepare failed is dropped from its
 * track after its commands were recorded as failed.
 */
async function prepareFastLaneTracks(context, tracks, options) {
  const failedStageIds = new Set();
  for (const track of tracks) {
    for (const stage of track.stages) {
      if (stage.prepare && !(await runFastLaneStagePrepare(context, stage, options))) {
        failedStageIds.add(stage.id);
      }
    }
  }
  return tracks.map((track) => ({
    ...track,
    stages: track.stages
      .filter((stage) => !failedStageIds.has(stage.id))
      .map((stage) => (stage.prepare ? { ...stage, prepare: undefined } : stage)),
  }));
}

/**
 * Runs a stage's one-off setup (the storage build) outside the manifest: the
 * merged CI manifest must record each scenario once, and every CI storage job
 * runs this step. A failed setup fails every command in the stage without
 * running it, so a broken build can never pass as a shard result.
 */
async function runFastLaneStagePrepare(context, stage, options) {
  const result = await options.runCommand(pnpmCommand(), stage.prepare.args, {
    cwd: repoRoot,
    artifactRoot: path.join(context.artifactRoot, "diagnostics"),
    logName: stage.prepare.id,
  });
  if (result.code === 0) {
    return true;
  }
  const error = clampString(
    `${stage.prepare.title} failed (exit ${result.code}); not run. ${result.stderr || result.stdout}`,
    1200,
  );
  for (const commandId of stage.commands) {
    const command = lookupFastLaneCommand(commandId);
    await runScenario(context, { id: command.id, lane: "fast", title: command.title, subsystem: "fast" }, async () => ({
      status: "failed",
      error,
      metrics: { exitCode: result.code, prepare: stage.prepare.id },
      artifacts: emptyArtifacts({
        logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
      }),
    }));
  }
  if (options.failFast) {
    throw new Error(`Fast lane stopped after ${stage.prepare.id} failed.`);
  }
  return false;
}

async function runFastLaneSerialStage(context, stage, options) {
  for (const commandId of stage.commands) {
    const scenario = await runFastLaneCommand(context, lookupFastLaneCommand(commandId), options);
    if (options.failFast && scenario.status === "failed") {
      throw new Error(`Fast lane stopped after failed scenario ${scenario.id}.`);
    }
  }
}

async function runFastLaneParallelStage(context, stage, options) {
  const pending = [...stage.commands];
  const workers = Array.from({ length: Math.min(resolveFastLaneStageConcurrency(stage), pending.length) }, async () => {
    while (pending.length > 0) {
      const commandId = pending.shift();
      if (!commandId) {
        return;
      }
      await runFastLaneCommand(context, lookupFastLaneCommand(commandId), options);
    }
  });
  await Promise.all(workers);
  if (options.failFast && context.manifest.scenarios.some((scenario) => scenario.status === "failed")) {
    throw new Error(`Fast lane stopped after failed parallel stage ${stage.id}.`);
  }
}

async function runFastLaneCommand(context, command, options = {}) {
  return await runScenario(
    context,
    {
      id: command.id,
      lane: "fast",
      title: command.title,
      subsystem: "fast",
    },
    async () => {
      if (options.injectFailureScenario === command.id) {
        return {
          status: "failed",
          error: `Injected failure for ${command.id}.`,
          metrics: { injected: true },
          artifacts: emptyArtifacts(),
        };
      }
      const preferredCommandTempRoot = await resolveFastLaneCommandTempRoot(context, command);
      const commandTempRoot = await prepareFastLaneCommandTempRoot(preferredCommandTempRoot);
      const env = await resolveFastLaneCommandEnv(context, command, commandTempRoot);
      try {
        const result = await (options.runCommand ?? runCommand)(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
          env,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          metrics: {
            exitCode: result.code,
            durationMs: result.durationMs,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
        };
      } finally {
        // Scratch only. Command evidence lives under the artifact root, so this
        // runs on the failing path too rather than leaving the largest roots behind
        // exactly when a run is most likely to be retried.
        await removeFastLaneCommandTempRoot(commandTempRoot);
      }
    },
  );
}

function lookupFastLaneCommand(commandId) {
  const command = FAST_LANE_COMMAND_BY_ID.get(commandId);
  if (!command) {
    throw new Error(`Unknown fast lane command: ${commandId}`);
  }
  return command;
}

export async function runA2AFullLane(context) {
  for (const command of A2A_FULL_LANE_COMMANDS) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "a2a-full",
        title: command.title,
        subsystem: "a2a",
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          metrics: {
            exitCode: result.code,
            durationMs: result.durationMs,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  }
}

export async function resolveFastLaneCommandTempRoot(context, command) {
  const tempBaseRoot = await resolveFastLaneTempBaseRoot(context);
  return path.join(tempBaseRoot, sanitizeFilePart(command.id));
}

// Removing a command's scratch root is best effort. The storage suite alone creates
// roughly 1200 SQLite databases per run, so leaving these roots behind accumulates
// gigabytes and measurably slows every later run on the same host. A lingering child
// still holding a Windows file handle must never convert a passing command into a
// lane failure, so a removal that cannot complete is reported rather than thrown.
export async function removeFastLaneCommandTempRoot(commandTempRoot, deps = {}) {
  const rm = deps.rm ?? fs.rm;
  try {
    await rm(commandTempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

export async function prepareFastLaneCommandTempRoot(preferredRoot, deps = {}) {
  const removeRoot = deps.removeRoot ?? removeFastLaneCommandTempRoot;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const mkdtemp = deps.mkdtemp ?? fs.mkdtemp;
  if (await removeRoot(preferredRoot)) {
    await mkdir(preferredRoot, { recursive: true });
    return preferredRoot;
  }

  // A locked Windows handle must not make the next command reuse stale SQLite
  // state. Leave the locked root alone and hand the command a fresh sibling.
  await mkdir(path.dirname(preferredRoot), { recursive: true });
  return await mkdtemp(`${preferredRoot}-fresh-`);
}

export async function resolveFastLaneCommandEnv(context, command, commandTempRoot) {
  const npmCacheRoot = path.join(commandTempRoot, "npm-cache");
  await fs.mkdir(commandTempRoot, { recursive: true });
  await fs.mkdir(npmCacheRoot, { recursive: true });
  const tempEnv = {
    NPM_CONFIG_CACHE: npmCacheRoot,
    TEMP: commandTempRoot,
    TMP: commandTempRoot,
    TMPDIR: commandTempRoot,
    npm_config_cache: npmCacheRoot,
  };
  if (command.id !== "fast.smoke") {
    return {
      ...tempEnv,
      ...(command.env ?? {}),
    };
  }
  const runtimeRoot = await prepareVerificationRuntime(`${context.runId}-fast-smoke`);
  return {
    ...tempEnv,
    ...(command.env ?? {}),
    GOATCITADEL_ROOT_DIR: runtimeRoot,
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
  };
}

async function resolveFastLaneTempBaseRoot(context) {
  const configuredTempRoot = process.env.GOATCITADEL_VERIFY_TEMP_ROOT?.trim();
  if (configuredTempRoot) {
    return path.join(configuredTempRoot, context.runId);
  }
  const systemTempRoot = path.join(
    os.tmpdir(),
    `gcv-${process.pid}`,
    sanitizeFilePart(String(context.runId)).slice(-24),
  );
  if (await hasMinimumFreeSpace(systemTempRoot, FAST_LANE_TEMP_MIN_FREE_BYTES)) {
    return systemTempRoot;
  }
  return path.join(context.artifactRoot, "tmp");
}

async function hasMinimumFreeSpace(candidatePath, minFreeBytes) {
  try {
    await fs.mkdir(candidatePath, { recursive: true });
    const stats = await fs.statfs(candidatePath);
    return Number(stats.bavail) * Number(stats.bsize) >= minFreeBytes;
  } catch {
    return false;
  }
}

function emptyArtifacts(overrides = {}) {
  return {
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
    ...overrides,
  };
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
