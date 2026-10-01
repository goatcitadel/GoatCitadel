import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { superviseNativeComparisonProcess } from "../../verification/lib/agent-comparison-native-driver.mjs";
import { inspectProcessBindingWithRetry } from "../../lib/managed-runtime-lifecycle.mjs";

export const GATEWAY_PROOF_TEST_COUNT = 18;
export const GATEWAY_PROOF_TEST_MS = 15_000;
export const GATEWAY_PROOF_HOOK_MS = 15_000;
export const GATEWAY_PROOF_STARTUP_MS = 60_000;
export const GATEWAY_PROOF_DEADLINE_MS = GATEWAY_PROOF_STARTUP_MS
  + GATEWAY_PROOF_TEST_COUNT * (GATEWAY_PROOF_TEST_MS + GATEWAY_PROOF_HOOK_MS);
export const NATIVE_PROOF_CLOSE_MS = 30_000;

/** Fixture aggregate only: individual compiler, test, hook and native bounds stay unchanged. */
export function nativeProvisioningBridgeBudget(sourceCount) {
  assert.ok(Number.isSafeInteger(sourceCount) && sourceCount > 0 && sourceCount <= 100);
  const fullClosureCompilerCalls = Math.ceil(sourceCount / 8) + 1;
  const compilerCalls = 2 * fullClosureCompilerCalls + 5; // Four small adapter links + parent fixture.
  const parentFixtureCalls = 2 + 1 + 2 * (1 + 3);
  const rawCalls = 4 + 2 * (3 + 2 * 11 + 2 * 3);
  const parts = { compilerMs: compilerCalls * 60_000, parentFixtureMs: parentFixtureCalls * 10_000,
    workerCoordinatorMs: 4 * 120_000, custodyAndControllerMs: 2 * 3_000,
    rawProtocolMs: rawCalls * 8_000, gatewayMs: GATEWAY_PROOF_DEADLINE_MS,
    closeMs: NATIVE_PROOF_CLOSE_MS, orchestrationMs: 60_000 };
  return { sourceCount, sourceBatchSize: 8, fullClosureCompilerCalls, compilerCalls,
    parentFixtureCalls, rawCalls, parts, totalMs: Object.values(parts).reduce((sum, value) => sum + value, 0) };
}

/** Bounded direct-root join. The shared supervisor deliberately does not certify every descendant. */
export async function runBoundedNativeProofCommand({ executablePath, args, cwd, environment, outputDirectory,
  signal, deadlineMs = GATEWAY_PROOF_DEADLINE_MS, maxOutputBytes = 4 * 1024 * 1024 }) {
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1 && deadlineMs <= GATEWAY_PROOF_DEADLINE_MS);
  assert.ok(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 1 && maxOutputBytes <= 4 * 1024 * 1024);
  const logPath = path.join(outputDirectory, "gateway-tests.log");
  const receiptPath = path.join(outputDirectory, "gateway-process.json");
  const descriptor = fs.openSync(logPath, "wx");
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  let child, result, originalBinding, closure, failure;
  const timer = setTimeout(() => controller.abort("deadline"), deadlineMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    child = superviseNativeComparisonProcess({ executablePath, args, cwd, environment,
      signal: combined, maxOutputBytes, onOutput: (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
          if (written <= 0) throw new Error("Native proof diagnostics could not be retained.");
          offset += written;
        }
      } });
    originalBinding = await inspectProcessBindingWithRetry({ rootPid: child.pid, servingPid: child.pid });
    if (originalBinding.status !== "verified") throw new Error("Native proof root creation identity was not verified.");
    result = await child.finished;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try {
      if (child) {
        await child.stop("supervisor_close");
        result ??= await child.finished;
        if (originalBinding?.status === "verified") {
          const after = await inspectProcessBindingWithRetry({ rootPid: child.pid, servingPid: child.pid });
          closure = { status: after.status === "missing" || (after.status === "verified" && after.rootIdentity !== originalBinding.rootIdentity)
            ? "verified_original_root_absent" : "unconfirmed", observed: after };
        }
      }
    } catch (error) { failure = failure ? new AggregateError([failure, error], "Native proof and root cleanup failed.") : error; }
    try { fs.closeSync(descriptor); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Native proof and diagnostic close failed.") : error; }
  }
  const receipt = { schemaVersion: "goatcitadel.native-proof-command.v1", startedAt, finishedAt: new Date().toISOString(),
    executablePath, args, cwd, pid: child?.pid ?? null, deadlineMs, maxOutputBytes,
    originalBinding: originalBinding ?? null, rootClosure: closure ?? { status: "unconfirmed" }, result: result ?? null,
    boundary: "Only the spawned root PID and observed OS creation identity are checked. Descendant closure is not certified by this receipt." };
  try { fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "Native proof and receipt publication failed.") : error; }
  if (!failure && (result?.stopReason !== "process_exit" || result.exitCode !== 0 || result.signal !== null
    || result.cleanupUnconfirmed || closure?.status !== "verified_original_root_absent")) {
    failure = new Error(`Native proof command failed (${result?.stopReason ?? "no_result"}, ${result?.exitCode ?? "no_exit"}); see retained diagnostics.`);
  }
  if (failure) {
    const original = failure instanceof Error ? failure : new Error("Native proof command failed with a non-Error cause.", { cause: failure });
    original.receipt = receipt; throw original;
  }
  return receipt;
}
