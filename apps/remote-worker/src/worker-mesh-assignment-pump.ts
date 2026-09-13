import { setTimeout as delay } from "node:timers/promises";
import type { WorkerMeshCapabilityCycleResult } from "./worker-mesh-capability-runtime.js";

/** One assignment and one serialized destination cycle may coexist. An assignment
 * can await a mesh effect on this worker; neither queue may block the other's poll.
 * Normal completion drains the current mesh cycle. Failure cancels both owners
 * and awaits them, leaving their durable journals as the recovery authority. */
export async function withWorkerMeshAssignmentPump<T>(input: {
  signal?: AbortSignal;
  assignment(signal: AbortSignal): Promise<T>;
  mesh(signal: AbortSignal): Promise<WorkerMeshCapabilityCycleResult>;
  onSettlement(result: Extract<WorkerMeshCapabilityCycleResult, { status: "settled" }>): void;
  wait?: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  input.signal?.throwIfAborted();
  const stop = new AbortController();
  const wake = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  const waitSignal = AbortSignal.any([signal, wake.signal]);
  const wait = input.wait ?? (async (signal: AbortSignal) => { await delay(1_000, undefined, { signal }); });
  let assignmentDone = false;
  let failure: unknown;
  let failed = false;
  const fail = (error: unknown) => {
    if (!failed) { failed = true; failure = error; }
    stop.abort();
    wake.abort();
  };
  // Defer entry so synchronous throws are captured and both branches are owned.
  const assignment = Promise.resolve().then(() => input.assignment(signal)).catch((error: unknown) => {
    fail(error);
    throw error;
  }).finally(() => { assignmentDone = true; wake.abort(); });
  const mesh = Promise.resolve().then(async () => {
    do {
      signal.throwIfAborted();
      const result = await input.mesh(signal);
      if (result.status === "settled") {
        input.onSettlement(result);
        if (result.manualReconciliationRequired)
          throw new Error("Worker mesh execution requires operator reconciliation.");
      }
      if (assignmentDone) break;
      try { await wait(waitSignal); }
      catch (error) { if (!assignmentDone || signal.aborted) throw error; }
    } while (!assignmentDone);
  }).catch((error: unknown) => { fail(error); throw error; });
  try {
    // allSettled drains owned I/O; rejecting Promise.all alone would leak it into
    // a subsequent worker cycle or release the state lock while it still writes.
    const [work] = await Promise.allSettled([assignment, mesh]);
    if (failed) throw failure;
    signal.throwIfAborted();
    if (work.status !== "fulfilled") throw work.reason;
    return work.value;
  } finally { stop.abort(); wake.abort(); }
}
