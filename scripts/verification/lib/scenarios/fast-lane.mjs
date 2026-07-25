import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clampString, maybeParseBool, repoRoot, runCommand, runScenario, sanitizeFilePart } from "../shared.mjs";
import { prepareVerificationRuntime } from "../runtime.mjs";
// The lane runs each package's `test:coverage` script rather than `test` so the
// production coverage gate can aggregate what this run already measured instead of
// executing every suite a second time. Instrumentation is close to free here
// (gateway +6%, storage faster because its coverage script runs compiled output),
// while the second full pass cost the pipeline roughly seventeen minutes.
const FAST_LANE_TEMP_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const FAST_LANE_SAFE_TEST_CONCURRENCY = 2;
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
  {
    id: "fast.test.gateway",
    title: "Gateway tests",
    args: ["--filter", "@goatcitadel/gateway", "test:coverage"],
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  },
  {
    id: "fast.test.storage",
    title: "Storage tests",
    args: ["--filter", "@goatcitadel/storage", "test:coverage"],
  },
  {
    id: "fast.test.mission-control-next",
    title: "Mission Control Next tests",
    args: ["--filter", "@goatcitadel/mission-control-next", "test:coverage"],
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
    commands: ["fast.test.gateway"],
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

export async function runFastLane(context, options = {}) {
  const failFast = maybeParseBool(options.failFast ?? process.env.GOATCITADEL_VERIFY_FAIL_FAST, false);
  const serial = failFast || maybeParseBool(options.serial ?? process.env.GOATCITADEL_VERIFY_SERIAL, false);
  const injectedFailureScenario =
    typeof options.injectFailureScenario === "string" ? options.injectFailureScenario : undefined;
  const executionOptions = { failFast, injectFailureScenario: injectedFailureScenario };
  const stages = serial
    ? [{ id: "fast.serial", mode: "serial", commands: FAST_LANE_COMMANDS.map((item) => item.id) }]
    : FAST_LANE_STAGES;

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
      const env = await resolveFastLaneCommandEnv(context, command);
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

async function resolveFastLaneCommandEnv(context, command) {
  const tempBaseRoot = await resolveFastLaneTempBaseRoot(context);
  const commandTempRoot = path.join(tempBaseRoot, sanitizeFilePart(command.id));
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
