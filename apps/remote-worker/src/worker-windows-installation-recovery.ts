import { canonicalJsonString, normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerRuntimeInstallRequest,
  readRemoteWorkerCellProvisioningCheckpoint, readRemoteWorkerRuntimeInstallOutcome, remoteWorkerRuntimeInstallRequestSha256,
  type RemoteWorkerCellProvisioningExchange, type RemoteWorkerRuntimeInstallRequest } from "@goatcitadel/contracts";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import type { LeaseBinding } from "./connected-worker-routes.js";
import { exchangeWorkerRuntimeInstallation, selectWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { withWindowsWorkerAssignmentAuthority, type WindowsWorkerAssignmentAuthorityInput } from "./worker-windows-assignment-authority.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody,
  type WindowsWorkerCellProvisioningImageGuard } from "./worker-windows-cell-provisioning.js";

/** Startup reconciliation is read-only locally. Absence preserves the existing
 * execution admission path; retained intent or failure never triggers copying. */
export async function reconcileWindowsWorkerAssignmentInstallation(input: WindowsWorkerAssignmentAuthorityInput) {
  const selected = await withWindowsWorkerAssignmentAuthority(input, 60000, async authority => {
    const selection = await authority.withCurrentLease(lease => selectWorkerRuntimeInstallation(authority.context, lease, authority.signal));
    return { selection, lease: authority.lease() };
  }, true);
  input.signal.throwIfAborted();
  if (!selected.selection.request) return { lease: selected.lease, evidence: null, outcome: null };
  const { history, request } = selected.selection;
  const recovered = await recoverWindowsWorkerAssignmentInstallation({ ...input, lease: selected.lease, history, request });
  input.signal.throwIfAborted();
  if (!recovered.evidence.record) throw new Error("Installation reconciliation requires a terminal retained outcome.");
  const outcome = readRemoteWorkerRuntimeInstallOutcome(recovered.evidence.record.outcomeHex, request, history);
  return { ...recovered, outcome };
}

/** Installed recovery composition. The retained Gateway request remains the
 * authority: no lookup may create it, admit copying or publish readiness.
 * Local intent-only evidence stays uncertain, with no automatic retry. */
export async function recoverWindowsWorkerAssignmentInstallation(input: WindowsWorkerAssignmentAuthorityInput & {
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
} & ({ readonly history: RemoteWorkerCellProvisioningExchange; readonly request: RemoteWorkerRuntimeInstallRequest } |
  { readonly selectRetained: true })) {
  const selecting = "selectRetained" in input;
  if (selecting && (input.selectRetained !== true || "request" in input || "history" in input))
    throw new Error("Canonical installation selection cannot accept caller request data.");
  const supplied = selecting ? null : { history: normalizeRemoteWorkerCellProvisioningExchange(input.history),
    request: normalizeRemoteWorkerRuntimeInstallRequest(input.request) };
  return withWindowsWorkerAssignmentAuthority(input, 60000, async authority => {
    const selected = supplied ?? await authority.withCurrentLease(lease => selectWorkerRuntimeInstallation(authority.context, lease, authority.signal));
    if (!selected.request) throw new Error("Installation recovery has no retained reviewed request.");
    const { history, request } = selected;
    const expected = Object.freeze({ nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) });
    const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
    if (request.journalIdentityHex !== first.journalIdentityHex || request.preparedSha256 !== first.recordSha256 ||
        request.checkpointSha256 !== history.mountedWorkspaceRecords?.at(-1)?.slice(-64))
      throw new Error("Installation recovery request differs from its retained journal.");
    // Holding the current lease keeps each snapshot and its subsequent evidence
    // exchange on one generation. Renewal can occur between native challenges.
    const exchangeForLease = async (lease: LeaseBinding, outcomeHex: string | null) => {
      const current = normalizeRemoteWorkerCellProvisioningExchange((await exchangeWorkerCellCapacity(authority.context,
        lease, { kind: "cell.capacity.snapshot" }, authority.signal)).history);
      authority.signal.throwIfAborted();
      if (current.registryWorkspaceId !== lease.registryWorkspaceId || current.assignmentId !== lease.assignmentId ||
          current.assignmentGeneration !== lease.assignmentGeneration || current.leaseRevision !== lease.leaseRevision ||
          canonicalJsonString({ ...current, leaseRevision: history.leaseRevision }) !== canonicalJsonString(history))
        throw new Error("Installation recovery history changed under the current lease.");
      const evidence = await exchangeWorkerRuntimeInstallation(authority.context, lease, request, current, outcomeHex, authority.signal);
      return { history: current, evidence };
    };
    const exchange = (outcomeHex: string | null) => authority.withCurrentLease(lease => exchangeForLease(lease, outcomeHex));
    const initial = await exchange(null);
    if (initial.evidence.record) return { lease: authority.lease(), evidence: initial.evidence };
    // A null canonical result permits only a read from original local custody.
    const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal: authority.signal,
      assertCurrent: authority.assertCurrent, imageGuard: input.imageGuard });
    const local = await authority.withStableLease(async (lease, check) => {
      const current = await exchangeForLease(lease, null);
      // Another delivery may have settled while custody was being inspected.
      // Use that freshly verified terminal record instead of requiring local
      // evidence again or submitting the same outcome a second time.
      if (current.evidence.record) return { evidence: current.evidence };
      const driver = createWindowsWorkerCellProvisioning({ parentPath: custody.parentPath, controllerService: true,
        wallMs: 60000, signal: authority.signal, assertCurrent: check, imageGuard: input.imageGuard });
      return driver.recoverRuntimeInstallation(current.history, request, expected, async candidate => {
        if (canonicalJsonString(normalizeRemoteWorkerRuntimeInstallRequest(candidate)) !== canonicalJsonString(request))
          throw new Error("Installation recovery authority changed its request.");
        await check();
        await exchangeForLease(lease, null);
      });
    });
    authority.signal.throwIfAborted();
    if ("evidence" in local) return { lease: authority.lease(), evidence: local.evidence };
    const retained = await exchange(local.outcomeHex);
    // Read back after retention as well: losing a response never causes copying.
    const confirmed = await exchange(null);
    if (!confirmed.evidence.record || !retained.evidence.record ||
        canonicalJsonString(confirmed.evidence.record) !== canonicalJsonString(retained.evidence.record))
      throw new Error("Installation recovery requires its exact retained outcome.");
    return { lease: authority.lease(), evidence: confirmed.evidence };
  }, true);
}
