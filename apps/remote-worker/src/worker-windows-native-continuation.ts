import { normalizeRemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { runWindowsWorkerAssignmentRuntime } from "./worker-windows-runtime-startup.js";
import type { WorkerNativeContinuationOwner } from "./worker-native-continuation.js";
import { requireWorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { ensureWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-startup.js";

type Input = Parameters<WorkerNativeContinuationOwner["run"]>[0];
type PolicyOwner = Parameters<typeof runWindowsWorkerAssignmentRuntime>[0]["runtime"]["owner"];

/** Installed host composition supplies current peer, input and output policy.
 * No configuration flag substitutes those owners or enables disk provisioning.
 * Selection is bound to the same canonical continuation on every request page. */
export function createWindowsWorkerNativeContinuation(
  resolvePolicyOwner: (input: Input) => Promise<PolicyOwner>,
): WorkerNativeContinuationOwner {
  return { run: async input => {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const continuation = normalizeRemoteWorkerNativeContinuation(input.continuation), lease = Object.freeze({ ...input.lease });
    if (process.platform !== "win32" || !input.context.credential.protectedKey)
      throw new Error("Installed native continuation requires protected Windows custody.");
    const protectedKeys = requireWorkerProtectedKeyOwner(input.context.credential.protectedKey, input.context.protectedKeys);
    if (continuation.decision !== "approved" || continuation.assignmentGeneration !== lease.assignmentGeneration)
      throw new Error("Installed native continuation requires its approved generation.");
    const context = Object.freeze({ ...input.context, credential: Object.freeze({ ...input.context.credential }), protectedKeys });
    const captured = { ...input, context, lease, continuation, signal };
    const owner = Object.freeze({ ...await resolvePolicyOwner(captured) });
    signal.throwIfAborted();
    const installation = await ensureWindowsWorkerAssignmentInstallation(captured);
    signal.throwIfAborted();
    if (installation.evidence) {
      input.observed.nativeInstallationEvidence = installation.evidence;
      if (!installation.outcome?.installation?.verified || installation.outcome.installation.error !== 0)
        throw new Error("Native execution requires reconciliation of the failed runtime installation.");
    }
    const { history } = await exchangeWorkerCellCapacity(context, installation.lease, { kind: "cell.capacity.snapshot" }, signal);
    signal.throwIfAborted();
    const result = await runWindowsWorkerAssignmentRuntime({ ...captured, lease: installation.lease, history,
      runtime: { selectAdmitted: true, continuation, owner } });
    signal.throwIfAborted();
    input.observed.nativeRuntimeOutcome = result.outcome;
    input.observed.nativeRuntimeReceipt = result.receipt;
    return { lease: result.lease };
  } };
}
