import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GATEWAY_COVERAGE_SHARD_COUNT, gatewayCoverageShardDirectory } from "../../../coverage-shard-contract.mjs";
import { clampString, maybeParseBool, repoRoot, runCommand, runScenario, sanitizeFilePart } from "../shared.mjs";
import { prepareVerificationRuntime } from "../runtime.mjs";
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
const GATEWAY_TEST_SHARDS = Object.freeze(
  Array.from({ length: GATEWAY_COVERAGE_SHARD_COUNT }, (_unused, index) => index + 1),
);
const FAST_LANE_LIBRARY_TEST_FILTERS = Object.freeze([
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
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
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
  {
    id: "fast.test.storage",
    title: "Storage tests",
    args: ["--filter", "@goatcitadel/storage", "test:coverage"],
    // The suite creates ~1,200 SQLite databases and replaying the migration
    // registry costs ~600ms each, which was about two thirds of this scenario.
    // The template snapshots the migrated schema once per process; the ledger is
    // still validated on every database.
    env: { GOATCITADEL_SQLITE_SCHEMA_TEMPLATE: "1" },
  },
  {
    id: "fast.test.mission-control-next",
    title: "Mission Control Next tests",
    args: [
      "--filter",
      "@goatcitadel/mission-control-next",
      "test:coverage",
      // This scenario runs beside the recursive library coverage command. An
      // uncapped Vitest pool on each side can oversubscribe a high-core host and
      // turn the shell's cold dynamic import into a false 20-second timeout.
      `--maxWorkers=${FAST_LANE_VITEST_MAX_WORKERS}`,
    ],
  },
  {
    id: "fast.test.policy-engine",
    title: "Policy engine tests",
    args: ["--filter", "@goatcitadel/policy-engine", "test:coverage"],
  },
  {
    id: "fast.test.libraries",
    title: "Library and desktop tests",
    args: [
      ...FAST_LANE_LIBRARY_TEST_FILTERS.flatMap((filter) => ["--filter", filter]),
      "-r",
      "--workspace-concurrency=2",
      "test:coverage",
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
    id: "fast.test.gateway",
    mode: "serial",
    commands: [...GATEWAY_TEST_SHARDS.map((shard) => `fast.test.gateway.shard${shard}`), "fast.test.gateway.node"],
  },
  {
    id: "fast.coverage.gateway",
    mode: "serial",
    commands: ["fast.coverage.gateway.smoke", "fast.coverage.gateway.exercise"],
  },
  {
    id: "fast.test.storage",
    mode: "serial",
    commands: ["fast.test.storage"],
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
  {
    id: "fast.post-tests",
    mode: "serial",
    commands: ["fast.smoke", "fast.build", "fast.docs"],
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

export function selectFastLaneStages(stages, selection) {
  if (!selection) {
    return stages;
  }
  const selected = stages
    .map((stage) => ({ ...stage, commands: stage.commands.filter((id) => selection.has(id)) }))
    .filter((stage) => stage.commands.length > 0);
  const scheduled = new Set(selected.flatMap((stage) => stage.commands));
  const dropped = [...selection].filter((id) => !scheduled.has(id));
  if (dropped.length > 0) {
    throw new Error(`Fast lane command id(s) not scheduled by any stage: ${dropped.join(", ")}.`);
  }
  return selected;
}

export async function runFastLane(context, options = {}) {
  const failFast = maybeParseBool(options.failFast ?? process.env.GOATCITADEL_VERIFY_FAIL_FAST, false);
  const serial = failFast || maybeParseBool(options.serial ?? process.env.GOATCITADEL_VERIFY_SERIAL, false);
  const injectedFailureScenario =
    typeof options.injectFailureScenario === "string" ? options.injectFailureScenario : undefined;
  const executionOptions = { failFast, injectFailureScenario: injectedFailureScenario };
  const selection = resolveFastLaneSelection(options.commands ?? process.env.GOATCITADEL_VERIFY_FAST_COMMANDS);
  const stages = selectFastLaneStages(
    serial
      ? [{ id: "fast.serial", mode: "serial", commands: FAST_LANE_COMMANDS.map((item) => item.id) }]
      : FAST_LANE_STAGES,
    selection,
  );

  for (const stage of stages) {
    if (stage.mode === "parallel") {
      await runFastLaneParallelStage(context, stage, executionOptions);
      continue;
    }
    await runFastLaneSerialStage(context, stage, executionOptions);
  }
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
  const workers = Array.from({ length: Math.min(stage.concurrency ?? 1, pending.length) }, async () => {
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
      const commandTempRoot = await resolveFastLaneCommandTempRoot(context, command);
      const env = await resolveFastLaneCommandEnv(context, command, commandTempRoot);
      try {
        const result = await runCommand(pnpmCommand(), command.args, {
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

export async function resolveFastLaneCommandEnv(context, command, commandTempRoot) {
  const npmCacheRoot = path.join(commandTempRoot, "npm-cache");
  // A crashed or killed earlier run leaves its scratch behind, and the Windows base
  // root is the shared user temp directory rather than a per-run path. Start from an
  // empty root so residue cannot carry across runs.
  await removeFastLaneCommandTempRoot(commandTempRoot);
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
  const systemTempRoot =
    process.platform === "win32" ? os.tmpdir() : path.join("/tmp", `gcv-${process.pid}`, context.runId.slice(-8));
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
