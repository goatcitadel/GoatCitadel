import { canonicalJsonString, normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerNativeFileExportSelection } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { withWindowsWorkerAssignmentAuthority, type WindowsWorkerAssignmentAuthorityInput } from "./worker-windows-assignment-authority.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody,
  type WindowsWorkerCellProvisioningImageGuard } from "./worker-windows-cell-provisioning.js";
import { runWindowsWorkerGatewayRuntime } from "./worker-windows-gateway-runtime.js";
import { authorizeWorkerRuntime } from "./worker-runtime-authorization-client.js";
import { authorizeWorkerNativeFile } from "./worker-native-file-grant-client.js";
import { transferWorkerNativeFiles } from "./worker-native-file-transfer-client.js";
import { downloadWorkerRuntimeRequest } from "./worker-runtime-request-client.js";
import { readWorkerRuntimeOutcome } from "./worker-runtime-outcome-client.js";
import { normalizeRemoteWorkerNativeContinuation, type RemoteWorkerNativeContinuation } from "@goatcitadel/contracts";

/** Installed execution entry point, separate from provisioning. The trusted
 * workload owner supplies an admitted request and request-specific policy ports;
 * no foreground configuration can substitute installed key/controller custody. */
export async function runWindowsWorkerAssignmentRuntime(input: WindowsWorkerAssignmentAuthorityInput & {
  readonly history: Parameters<typeof runWindowsWorkerGatewayRuntime>[2];
  readonly runtime: Parameters<typeof runWindowsWorkerGatewayRuntime>[3] | {
    readonly selectAdmitted: true; readonly owner: Parameters<typeof runWindowsWorkerGatewayRuntime>[3]["owner"];
    readonly continuation?: RemoteWorkerNativeContinuation;
  };
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
}) {
  const history = normalizeRemoteWorkerCellProvisioningExchange(input.history);
  const selected = "selectAdmitted" in input.runtime;
  const continuation = selected && input.runtime.continuation !== undefined ? normalizeRemoteWorkerNativeContinuation(input.runtime.continuation) : undefined;
  if (continuation && (continuation.decision !== "approved" || continuation.assignmentGeneration !== input.lease.assignmentGeneration))
    throw new Error("Native startup requires its approved assignment continuation.");
  if (selected && (input.runtime.selectAdmitted !== true || "request" in input.runtime || "expected" in input.runtime))
    throw new Error("Native workload selection cannot accept caller executable bytes.");
  const supplied = selected ? null : { request: normalizeWindowsRuntimeDispatch(input.runtime.request),
    expected: normalizeRemoteWorkerRuntimeResultExpectation(input.runtime.expected) };
  const ports = Object.freeze({ ...input.runtime.owner });
  if (supplied && canonicalJsonString(prepareWindowsRuntimeDispatch(supplied.request).expectation) !== canonicalJsonString(supplied.expected))
    throw new Error("Native execution request differs from its admission.");
  const signal = AbortSignal.any([input.signal, ports.signal]);
  return await withWindowsWorkerAssignmentAuthority({ ...input, signal }, ports.timeoutMs, async (authority) => {
    const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal: authority.signal,
      assertCurrent: authority.assertCurrent, imageGuard: input.imageGuard });
    await authority.assertCurrent();
    let lease = authority.lease();
    let currentHistory = normalizeRemoteWorkerCellProvisioningExchange((await exchangeWorkerCellCapacity(authority.context,
      lease, { kind: "cell.capacity.snapshot" }, authority.signal)).history);
    authority.signal.throwIfAborted();
    if (history.registryWorkspaceId !== lease.registryWorkspaceId || history.assignmentId !== lease.assignmentId ||
        history.assignmentGeneration !== lease.assignmentGeneration || currentHistory.leaseRevision !== lease.leaseRevision ||
        canonicalJsonString({ ...currentHistory, leaseRevision: history.leaseRevision }) !== canonicalJsonString(history))
      throw new Error("Native execution history changed before dispatch.");
    const dispatch = supplied ?? await authority.withCurrentLease(async current => {
      const downloaded = await downloadWorkerRuntimeRequest(authority.context, current, authority.signal, continuation);
      // The download may have renewed the lease before holding it. Rebind the
      // helper's initial history and result lookup to that exact current lease.
      const refreshed = normalizeRemoteWorkerCellProvisioningExchange((await exchangeWorkerCellCapacity(authority.context,
        current, { kind: "cell.capacity.snapshot" }, authority.signal)).history);
      authority.signal.throwIfAborted();
      if (refreshed.leaseRevision !== current.leaseRevision || canonicalJsonString({ ...refreshed, leaseRevision: history.leaseRevision }) !== canonicalJsonString(history))
        throw new Error("Native execution history changed during request download.");
      lease = current; currentHistory = refreshed; return downloaded;
    });
    const request = normalizeWindowsRuntimeDispatch(dispatch.request), expected = normalizeRemoteWorkerRuntimeResultExpectation(dispatch.expected);
    if (canonicalJsonString(prepareWindowsRuntimeDispatch(request).expectation) !== canonicalJsonString(expected))
      throw new Error("Downloaded native request differs from its admission.");
    if (request.fileStaging && (typeof ports.authorizeFile !== "function" || typeof ports.consumeFiles !== "function"))
      throw new Error("Native file delivery requires local authorization and a complete-batch consumer before dispatch.");
    const checkRequest = (candidate: unknown, candidateHistory: Parameters<typeof ports.authorizeRuntime>[1]) => {
      if (canonicalJsonString(normalizeRemoteWorkerRuntimeResultExpectation(candidate)) !== canonicalJsonString(expected) ||
          canonicalJsonString(normalizeRemoteWorkerCellProvisioningExchange(candidateHistory)) !== canonicalJsonString(currentHistory))
        throw new Error("Native authorization callback changed its admitted request or journal.");
    };
    const checkGateway = async (phase: "execution" | "delivery", callSignal: AbortSignal) => {
      const stop = AbortSignal.any([authority.signal, callSignal]); stop.throwIfAborted();
      await authority.withCurrentLease(current => authorizeWorkerRuntime(authority.context, current, expected, phase, stop));
      stop.throwIfAborted();
    };
    const owner = { ...ports, signal: authority.signal,
      consumeFiles: async (...args: Parameters<NonNullable<typeof ports.consumeFiles>>) => {
        if (!request.fileStaging || !ports.consumeFiles) throw new Error("Native transfer requires its admitted plan and local consumer.");
        const stop = AbortSignal.any([authority.signal, args[1]]); stop.throwIfAborted();
        await transferWorkerNativeFiles(authority.context, authority, expected, request.fileStaging, args[0], stop,
          () => ports.consumeFiles!(args[0], stop));
        stop.throwIfAborted();
      },
      authorizePeer: async (callSignal: AbortSignal) => { authority.signal.throwIfAborted(); callSignal.throwIfAborted(); await ports.authorizePeer(callSignal); },
      authorizeRuntime: async (...args: Parameters<typeof ports.authorizeRuntime>) => {
        checkRequest(args[0], args[1]); await ports.authorizeRuntime(...args); await checkGateway("execution", args[3]);
      },
      authorizeInput: async (...args: Parameters<typeof ports.authorizeInput>) => {
        checkRequest(args[0], args[1]); await ports.authorizeInput(...args); await checkGateway("execution", args[3]);
      },
      authorizeDelivery: async (...args: Parameters<typeof ports.authorizeDelivery>) => {
        checkRequest(args[0], args[1]); await ports.authorizeDelivery(...args); await checkGateway("delivery", args[3]);
      },
      authorizeRetention: async (...args: Parameters<typeof ports.authorizeRetention>) => {
        checkRequest(args[0], args[1]); await ports.authorizeRetention(...args); await checkGateway("delivery", args[2]);
      },
      authorizeFile: async (...args: Parameters<NonNullable<typeof ports.authorizeFile>>) => {
        checkRequest(args[0], args[1]);
        if (!request.fileStaging || !ports.authorizeFile) throw new Error("Native file disclosure requires its admitted plan and local authority.");
        const selection = normalizeRemoteWorkerNativeFileExportSelection(args[2]);
        if (selection.nonce !== expected.nonce || selection.requestSha256 !== expected.requestSha256)
          throw new Error("Native file disclosure differs from its admitted request.");
        const stop = AbortSignal.any([authority.signal, args[3]]); stop.throwIfAborted();
        await ports.authorizeFile(args[0], args[1], selection, args[3]); stop.throwIfAborted();
        await authority.withCurrentLease(current => authorizeWorkerNativeFile(authority.context, current, selection, request.fileStaging!, stop));
        stop.throwIfAborted();
      },
    };
    const driver = createWindowsWorkerCellProvisioning({ parentPath: custody.parentPath, controllerService: true,
      wallMs: ports.timeoutMs, signal: authority.signal, assertCurrent: authority.assertCurrent, imageGuard: input.imageGuard });
    const receipt = await runWindowsWorkerGatewayRuntime(driver, { context: authority.context, lease, leaseOwner: authority },
    currentHistory, { request, expected, owner }, authority.assertCurrent);
    const recorded = await authority.withCurrentLease(current => readWorkerRuntimeOutcome(authority.context, current, expected, authority.signal));
    if (!recorded.outcome || canonicalJsonString(recorded.lookup.record) !== canonicalJsonString(receipt))
      throw new Error("Native completion requires its exact retained outcome.");
    return { lease: authority.lease(), receipt, outcome: recorded.outcome };
  }, true);
}
