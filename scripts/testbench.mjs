import fs from "node:fs/promises";
import path from "node:path";
import {
  WORKTREE_OUTPUT_LOCK_LEASE_ENV,
  WORKTREE_OUTPUT_LOCK_PATH_ENV,
  WORKTREE_OUTPUT_LOCK_ROOT_ENV,
  acquireWorktreeOutputLock,
} from "./lib/worktree-output-lock.mjs";
import {
  ensureGatewayWorkspaceBuild,
  resolveAvailablePort,
  startVerificationStack,
  stopVerificationStack,
} from "./verification/lib/runtime.mjs";
import { ensureOnboardingComplete } from "./verification/lib/scenarios.mjs";
import { startDeterministicLlmStub } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { collectVerificationSecretEnvKeys } from "./verification/lib/scenarios/usability-coverage.mjs";
import { createRunId, repoRoot } from "./verification/lib/shared.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchEnvOmit,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

const STOP_FILE_NAME = "stop";
const STOP_FILE_POLL_MS = 1000;
// A child that dies because of a console Ctrl+C exits just before or after our own SIGINT handler runs.
// Waiting briefly lets that deliberate stop win, so only a genuinely unexpected exit sets the failure code.
const CHILD_EXIT_GRACE_MS = 500;

function say(message) {
  process.stdout.write(`[testbench] ${message}\n`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    // Best-effort probe: any failure to see the file means "not requested yet".
    return false;
  }
}

/**
 * Arms every deliberate shutdown trigger: Ctrl+C, SIGTERM, and the stop file. It is armed at the very start of
 * main(), before anything is started, so a stop request at any point leads to the same teardown. The stop file
 * exists because a background launcher on Windows cannot be sent Ctrl+C, and killing it would skip teardown
 * (orphaned gateway/Vite processes and a leftover sandbox root).
 *
 * The signal listeners and the poll stay installed until `dispose()`, which main() calls only after teardown has
 * finished, so a second signal during cleanup cannot hit the default handler and abort it half-way.
 */
function armShutdownTrigger(stopFile) {
  let requested = false;
  let probing = false;
  let announce;
  const promise = new Promise((resolve) => {
    announce = resolve;
  });

  /** Returns false when a stop was already requested. `failed` marks an unexpected stop (exit code 1). */
  const request = (message, { failed = false } = {}) => {
    if (requested) return false;
    requested = true;
    if (failed) process.exitCode = 1;
    say(message);
    announce();
    return true;
  };

  const onSignal = () => {
    if (!request("Stopping the test bench…")) say("Already stopping…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const poll = setInterval(() => {
    if (probing || requested) return;
    probing = true;
    pathExists(stopFile).then((found) => {
      probing = false;
      if (found) request(`Stop file found (${stopFile}). Stopping the test bench…`);
    });
  }, STOP_FILE_POLL_MS);

  return {
    request,
    promise,
    requested: () => requested,
    dispose() {
      clearInterval(poll);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

/** Treats an exit of the sandbox gateway or the UI as a failed stop. Returns a function that stops watching. */
function watchChildExits(stack, trigger, logRoot) {
  const cleanups = [];
  const watch = (child, describe) => {
    if (!child) return;
    const report = (code) => {
      const message = describe(code ?? child.signalCode);
      const timer = setTimeout(() => trigger.request(message, { failed: true }), CHILD_EXIT_GRACE_MS);
      cleanups.push(() => clearTimeout(timer));
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      // Already gone before we started listening: report it instead of waiting forever.
      report(child.exitCode);
      return;
    }
    child.once("exit", report);
    cleanups.push(() => child.off("exit", report));
  };
  watch(stack.gateway?.child, (code) => `The sandbox gateway exited (code ${code}). Logs: ${logRoot}`);
  watch(stack.ui?.child, (code) => `The test bench UI exited (code ${code}). Logs: ${logRoot}`);
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Awaits `work` to completion even when a stop arrives meanwhile: it owns processes that only teardown can stop,
 * so its handles must arrive (or it must fail and clean up after itself) before teardown runs.
 */
async function runPhase(label, work, trigger) {
  const settled = work.then(
    () => "settled",
    () => "settled",
  );
  const first = await Promise.race([settled, trigger.promise.then(() => "stop")]);
  if (first === "stop") {
    say(`Stop requested during ${label}; waiting for it to settle so everything it started is shut down…`);
  }
  return await work;
}

async function teardown({ stub, stack, runtimeRoot }) {
  if (stub || stack || runtimeRoot) say("Cleaning up the sandbox…");
  if (stub) {
    await stub.close().catch((error) => {
      process.stderr.write(`[testbench] Closing the LLM stub failed (best-effort cleanup): ${error.message}\n`);
    });
  }
  if (stack || runtimeRoot) {
    // Stops only the processes this launcher started and deletes the sandbox root; never throws.
    await stopVerificationStack(stack ?? { runtimeRoot });
  }
}

const OUTPUT_LOCK_ENV_KEYS = new Set([
  WORKTREE_OUTPUT_LOCK_LEASE_ENV,
  WORKTREE_OUTPUT_LOCK_PATH_ENV,
  WORKTREE_OUTPUT_LOCK_ROOT_ENV,
]);

/**
 * Builds the gateway workspace while holding the worktree output lock, so a concurrent build, typecheck, or second
 * test bench in this checkout cannot rewrite the same outputs mid-build (a held lock fails fast, naming its owner).
 * The build's pnpm children inherit the lease, which is re-entrant through the environment. The lock is released
 * before the gateway and UI start, so neither long-lived child carries it.
 */
async function buildGatewayWorkspaceLocked(context, envOmit) {
  const lease = await acquireWorktreeOutputLock({ repoRoot, owner: "testbench:startup-build" });
  try {
    await ensureGatewayWorkspaceBuild(context, {
      omitEnv: envOmit.filter((key) => !OUTPUT_LOCK_ENV_KEYS.has(key)),
      processLogPrefix: "testbench",
    });
  } finally {
    await lease.release();
  }
}

/**
 * Starts the stub, the isolated runtime, the gateway, and the UI. Everything started is recorded on `started` so
 * the caller's teardown can stop it. Returns true when the sandbox is ready, and false when a stop was requested
 * first (the remaining phases, including the ready output, are skipped).
 */
async function launchSandbox({ runId, artifactRoot, logRoot }, trigger, started) {
  // A plain context, not createRunContext: holding the worktree output lock for the whole session would block every
  // build in this checkout. Only the startup build takes it (see buildGatewayWorkspaceLocked).
  const context = { runId, artifactRoot };
  say("Starting the deterministic LLM stub…");
  started.stub = await startDeterministicLlmStub({ expectedAuthorization: `Bearer ${TESTBENCH_STUB_KEY}` });
  if (trigger.requested()) return false;
  say("Preparing an isolated runtime from shipped defaults…");
  started.runtimeRoot = await prepareTestbenchRuntime({ runId, stubBaseUrl: started.stub.baseUrl });
  if (trigger.requested()) return false;
  // The children inherit no secrets and no GOATCITADEL_* / VITE_GOATCITADEL_* variables from this shell; only the
  // explicit gatewayEnv and uiEnv settings below apply. Computed before the build lock exists, so it never lists the
  // lock's lease variables.
  const envOmit = buildTestbenchEnvOmit(await collectVerificationSecretEnvKeys(path.join(repoRoot, "config")));
  if (trigger.requested()) return false;
  // The build is synchronous and blocks this process's event loop, so Ctrl+C, SIGTERM, and the stop file are only
  // noticed once it returns. startVerificationStack below reuses this build instead of building again.
  say(
    "Building the gateway workspace. The first build can take several minutes; " +
      "stopping takes effect after the build finishes…",
  );
  await runPhase("the build", buildGatewayWorkspaceLocked(context, envOmit), trigger);
  if (trigger.requested()) return false;
  // Picked after the build, so a minutes-long build cannot let another process take the port first.
  const gatewayPort = await resolveAvailablePort(0);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  say("Starting the sandbox gateway and UI…");
  started.stack = await runPhase(
    "startup",
    startVerificationStack(context, {
      runtimeRoot: started.runtimeRoot,
      gatewayPort,
      gatewayMode: "built",
      includeUi: true,
      processLogPrefix: "testbench",
      gatewayEnvOmit: envOmit,
      uiEnvOmit: envOmit,
      gatewayEnv: buildTestbenchGatewayEnv(started.runtimeRoot),
      uiEnv: buildTestbenchUiEnv({ gatewayUrl, runtimeRoot: started.runtimeRoot }),
    }),
    trigger,
  );
  started.stopWatching = watchChildExits(started.stack, trigger, logRoot);
  if (trigger.requested()) return false;
  if (started.stack.gatewayUrl !== gatewayUrl) {
    throw new Error(`The gateway started on ${started.stack.gatewayUrl}, not ${gatewayUrl}. Run pnpm testbench again.`);
  }
  say("Completing onboarding on the sandbox…");
  await runPhase("onboarding", ensureOnboardingComplete(started.stack.gatewayUrl, "testbench"), trigger);
  return !trigger.requested();
}

function announceReady({ stack, runtimeRoot }, { logRoot, stopFile }) {
  say("Sandbox ready.");
  say(`Test bench: ${buildTestbenchUrl(stack.uiUrl)}`);
  say(`Sandbox gateway: ${stack.gatewayUrl}`);
  say(`Sandbox runtime root: ${runtimeRoot}`);
  say(`Logs (written when each process exits): ${logRoot}`);
  say("Press Ctrl+C to stop the sandbox and delete its runtime folder.");
  say(`To stop from another shell, create: ${stopFile}`);
}

async function main() {
  const runId = createRunId("testbench");
  const artifactRoot = path.join(repoRoot, "artifacts", "testbench", runId);
  const paths = {
    runId,
    artifactRoot,
    logRoot: path.join(artifactRoot, "diagnostics"),
    stopFile: path.join(artifactRoot, STOP_FILE_NAME),
  };
  const trigger = armShutdownTrigger(paths.stopFile);
  const started = {};
  try {
    await fs.mkdir(paths.logRoot, { recursive: true });
    say(`Run ${runId}. To stop from another shell at any time, create: ${paths.stopFile}`);
    if (await launchSandbox(paths, trigger, started)) {
      announceReady(started, paths);
      await trigger.promise;
    }
  } finally {
    // Our own teardown kills the children; it must not be reported as an unexpected exit.
    started.stopWatching?.();
    try {
      await teardown(started);
    } finally {
      trigger.dispose();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[testbench] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
