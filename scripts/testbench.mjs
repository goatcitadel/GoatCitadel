import fs from "node:fs/promises";
import path from "node:path";
import { resolveAvailablePort, startVerificationStack, stopVerificationStack } from "./verification/lib/runtime.mjs";
import { ensureOnboardingComplete } from "./verification/lib/scenarios.mjs";
import { startDeterministicLlmStub } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { collectVerificationSecretEnvKeys } from "./verification/lib/scenarios/usability-coverage.mjs";
import { createRunId, repoRoot } from "./verification/lib/shared.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

const STOP_FILE_NAME = "stop";
const STOP_FILE_POLL_MS = 1000;

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
 * Resolves on the first stop signal: Ctrl+C / SIGTERM, a child process exiting, or the stop file appearing.
 * The stop file exists because a background launcher on Windows cannot be sent Ctrl+C, and killing it
 * would skip teardown (orphaned gateway/Vite processes and a leftover sandbox root).
 */
function waitForShutdown(stack, logRoot, stopFile) {
  return new Promise((resolve) => {
    let settled = false;
    let probing = false;
    const cleanups = [];

    const finish = (message) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      say(message);
      resolve();
    };

    const poll = setInterval(() => {
      if (probing || settled) return;
      probing = true;
      pathExists(stopFile).then((found) => {
        probing = false;
        if (found) finish(`Stop file found (${stopFile}). Stopping the test bench…`);
      });
    }, STOP_FILE_POLL_MS);
    cleanups.push(() => clearInterval(poll));

    const onSignal = () => finish("Stopping the test bench…");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    cleanups.push(
      () => process.off("SIGINT", onSignal),
      () => process.off("SIGTERM", onSignal),
    );

    const watchChild = (child, message) => {
      if (!child) return;
      const onExit = (code) => finish(message(code));
      if (child.exitCode !== null || child.signalCode !== null) {
        // Already gone before we started listening: report it now instead of waiting forever.
        onExit(child.exitCode);
        return;
      }
      child.once("exit", onExit);
      cleanups.push(() => child.off("exit", onExit));
    };
    watchChild(stack.gateway?.child, (code) => `The sandbox gateway exited (code ${code}). Logs: ${logRoot}`);
    watchChild(stack.ui?.child, (code) => `The test bench UI exited (code ${code}). Logs: ${logRoot}`);
  });
}

async function teardown({ stub, stack, runtimeRoot }) {
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

async function main() {
  const runId = createRunId("testbench");
  const artifactRoot = path.join(repoRoot, "artifacts", "testbench", runId);
  const logRoot = path.join(artifactRoot, "diagnostics");
  const stopFile = path.join(artifactRoot, STOP_FILE_NAME);
  await fs.mkdir(logRoot, { recursive: true });
  // A plain context, not createRunContext: holding the worktree output lock would block every build.
  const context = { runId, artifactRoot };
  const started = {};
  try {
    say("Starting the deterministic LLM stub…");
    started.stub = await startDeterministicLlmStub({ expectedAuthorization: `Bearer ${TESTBENCH_STUB_KEY}` });
    say("Preparing an isolated runtime from shipped defaults…");
    started.runtimeRoot = await prepareTestbenchRuntime({ runId, stubBaseUrl: started.stub.baseUrl });
    const gatewayPort = await resolveAvailablePort(0);
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
    say("Building the gateway workspace and starting the sandbox. The first build can take several minutes…");
    started.stack = await startVerificationStack(context, {
      runtimeRoot: started.runtimeRoot,
      gatewayPort,
      gatewayMode: "built",
      includeUi: true,
      processLogPrefix: "testbench",
      gatewayEnvOmit: secretEnvKeys,
      uiEnvOmit: secretEnvKeys,
      gatewayEnv: buildTestbenchGatewayEnv(started.runtimeRoot),
      uiEnv: buildTestbenchUiEnv({ gatewayUrl, runtimeRoot: started.runtimeRoot }),
    });
    if (started.stack.gatewayUrl !== gatewayUrl) {
      throw new Error(`The gateway started on ${started.stack.gatewayUrl}, not ${gatewayUrl}. Run pnpm testbench again.`);
    }
    say("Completing onboarding on the sandbox…");
    await ensureOnboardingComplete(started.stack.gatewayUrl, "testbench");
    say("Sandbox ready.");
    say(`Test bench: ${buildTestbenchUrl(started.stack.uiUrl)}`);
    say(`Sandbox gateway: ${started.stack.gatewayUrl}`);
    say(`Sandbox runtime root: ${started.runtimeRoot}`);
    say(`Logs (written when each process exits): ${logRoot}`);
    say("Press Ctrl+C to stop the sandbox and delete its runtime folder.");
    say(`To stop from another shell, create: ${stopFile}`);
    await waitForShutdown(started.stack, logRoot, stopFile);
  } finally {
    await teardown(started);
  }
}

main().catch((error) => {
  process.stderr.write(`[testbench] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
