import { canonicalJsonString, normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerRuntimeResultExpectation,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { createWindowsWorkerCellProvisioning, WindowsWorkerCellRuntimeRequest } from "./worker-windows-cell-provisioning.js";
import { createWindowsRuntimeGatewayOwner, type WindowsRuntimeParentSessionOwner, type WindowsRuntimeGatewayLeaseOwner } from "./worker-windows-runtime-parent-session.js";
import { exchangeWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import { reconcileWorkerNativeFiles } from "./worker-native-file-reconciliation-client.js";

/** Trusted dispatch composition. Request selection and admission remain Gateway
 * owned; this connects the admitted request to the pinned native helper and
 * protected result upload. It never retries an uncertain launch. */
export async function runWindowsWorkerGatewayRuntime(
  driver: Pick<ReturnType<typeof createWindowsWorkerCellProvisioning>, "runRuntime">,
  transport: { readonly context: RouteContext; readonly lease: LeaseBinding;
    readonly leaseOwner?: WindowsRuntimeGatewayLeaseOwner;
    readonly currentLease?: (signal: AbortSignal) => Promise<LeaseBinding> },
  history: RemoteWorkerCellProvisioningExchange,
  input: Omit<WindowsWorkerCellRuntimeRequest, "owner"> & {
    readonly owner: Omit<WindowsRuntimeParentSessionOwner, "retain">;
  },
  authorize: () => Promise<void>,
) {
  const retained = normalizeRemoteWorkerCellProvisioningExchange(history);
  const expected = normalizeRemoteWorkerRuntimeResultExpectation(input.expected);
  const request = normalizeWindowsRuntimeDispatch(input.request);
  if (canonicalJsonString(prepareWindowsRuntimeDispatch(request).expectation) !== canonicalJsonString(expected))
    throw new Error("Native dispatch does not match its admitted request.");
  const context = Object.freeze({ ...transport.context }), binding = Object.freeze({ ...transport.lease });
  const currentLease = transport.currentLease, leaseOwner = transport.leaseOwner;
  const owner = createWindowsRuntimeGatewayOwner(context, binding, expected, retained, input.owner, currentLease, leaseOwner);
  owner.signal.throwIfAborted();
  // An exact retained result resolves a lost completion response without
  // reopening the native launch path. Missing results do not prove no launch:
  // the pinned helper must still refuse any previously recorded launch intent.
  const prior = await exchangeWorkerRuntimeResult(context, binding,
    { kind: "runtime.result.lookup", nonce: expected.nonce, requestSha256: expected.requestSha256 }, owner.signal);
  owner.signal.throwIfAborted();
  const reconcileFiles = async (record: NonNullable<typeof prior.record>) => {
    const read = (lease: LeaseBinding) => {
      const current = Object.freeze({ ...lease });
      owner.signal.throwIfAborted();
      if (current.registryWorkspaceId !== binding.registryWorkspaceId || current.assignmentId !== binding.assignmentId ||
          current.assignmentGeneration !== binding.assignmentGeneration || !Number.isSafeInteger(current.leaseRevision) || current.leaseRevision < binding.leaseRevision)
        throw new Error("Native file reconciliation requires the current assignment lease.");
      return reconcileWorkerNativeFiles(context, current, expected, owner.signal);
    };
    const files = leaseOwner ? await leaseOwner.withCurrentLease(read) : await read(currentLease ? await currentLease(owner.signal) : binding);
    owner.signal.throwIfAborted();
    if (!files.settlement || canonicalJsonString(files.lookup.record) !== canonicalJsonString(record))
      throw new Error("Native result is retained, but file settlement requires separate reconciliation; execution will not be replayed.");
  };
  if (prior.record) {
    // Result retention precedes file delivery. Require separate durable artifact
    // settlement before returning, without reopening the recorded workload.
    if (request.fileStaging) await reconcileFiles(prior.record);
    return prior.record;
  }
  // The driver repeats authorization at its native boundaries and keeps its
  // helper/pipe lifetime until terminal retention and exact process exit.
  const record = await driver.runRuntime(retained, { request, expected, owner }, authorize);
  if (request.fileStaging) await reconcileFiles(record);
  return record;
}
