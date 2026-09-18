import { canonicalJsonString, readRemoteWorkerRuntimeInstallOutcome, remoteWorkerRuntimeInstallRequestSha256 } from "@goatcitadel/contracts";
import { withWindowsWorkerAssignmentAuthority, type WindowsWorkerAssignmentAuthorityInput } from "./worker-windows-assignment-authority.js";
import { selectWorkerRuntimeInstallation, exchangeWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { openWorkerInstallationSession } from "./worker-installation-session-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { readWorkerNativePoolCleanupOnLease } from "./worker-native-pool-client.js";
import { readWindowsAssignmentCleanupOnLease } from "./worker-windows-assignment-cleanup.js";
import { recoverWindowsWorkerAssignmentInstallation } from "./worker-windows-installation-recovery.js";

/** First-install composition. A current reviewed request selects the combined
 * controller capture/install operation. Native CREATE_NEW intent is mandatory:
 * an existing or uncertain local attempt cannot copy again. On any failure,
 * only the existing read-only recovery path runs; no installation retry. */
export async function ensureWindowsWorkerAssignmentInstallation(input: WindowsWorkerAssignmentAuthorityInput) {
  let recoveryLease = input.lease;
  try {
    return await withWindowsWorkerAssignmentAuthority(input, 120000, authority => authority.withStableLease(async (lease, check) => {
      recoveryLease = lease;
      const selected = await selectWorkerRuntimeInstallation(authority.context, lease, authority.signal);
      await check();
      if (!selected.request) return { lease, evidence: null, outcome: null };
      const { request } = selected;
      const prior = await exchangeWorkerRuntimeInstallation(authority.context, lease, request, selected.history, null, authority.signal);
      if (prior.record) return { lease, evidence: prior, outcome: readRemoteWorkerRuntimeInstallOutcome(prior.record.outcomeHex, request, selected.history) };
      const session = await openWorkerInstallationSession(authority.context, lease, request, authority.signal);
      try {
        if (canonicalJsonString(session.history) !== canonicalJsonString(selected.history)) throw new Error("Installation history changed before capture.");
        const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal: authority.signal, assertCurrent: check });
        const driver = createWindowsWorkerCellProvisioning({ parentPath: custody.parentPath, controllerService: true,
          wallMs: 60000, signal: authority.signal, assertCurrent: check,
          readPoolCleanup: signal => readWorkerNativePoolCleanupOnLease({ context: authority.context, lease, signal, assertCurrent: check }),
          readCleanup: (expectedHistory, signal) => readWindowsAssignmentCleanupOnLease({ context: authority.context, lease, signal,
            assertCurrent: check, expectedHistory }) });
        const authorize = async () => {
          await check();
          const current = await exchangeWorkerRuntimeInstallation(authority.context, lease, request, session.history, null, authority.signal);
          if (current.record) throw new Error("Installation already has retained terminal evidence.");
          await check();
        };
        const installed = await driver.installRuntimeWithCapacity(session.history, request,
          { nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) }, authorize,
          async receipt => {
            const outcome = readRemoteWorkerRuntimeInstallOutcome(receipt.outcomeHex, request, session.history);
            if (!outcome.installation?.verified || outcome.installation.error) throw new Error("Installation finish requires verified native evidence.");
            await check();
          }, session.capture, session.admission);
        await check();
        const retained = await exchangeWorkerRuntimeInstallation(authority.context, lease, request, session.history, installed.outcomeHex, authority.signal);
        const confirmed = await exchangeWorkerRuntimeInstallation(authority.context, lease, request, session.history, null, authority.signal);
        if (!confirmed.record || canonicalJsonString(confirmed.record) !== canonicalJsonString(retained.record))
          throw new Error("Installation requires exact retained terminal evidence.");
        return { lease, evidence: confirmed, outcome: readRemoteWorkerRuntimeInstallOutcome(confirmed.record.outcomeHex, request, session.history) };
      } finally { session.close(); }
    }), true);
  } catch (error) {
    input.signal.throwIfAborted();
    // This path never calls installRuntimeWithCapacity or generates a new nonce.
    // A partial native intent stays uncertain and is not retried for copying.
    try {
      const recovered = await recoverWindowsWorkerAssignmentInstallation({ ...input, lease: recoveryLease, selectRetained: true });
      if (!recovered.evidence.record) throw error;
      const current = await withWindowsWorkerAssignmentAuthority({ ...input, lease: recovered.lease }, 60000,
        authority => authority.withCurrentLease(async lease => ({ lease,
          selected: await selectWorkerRuntimeInstallation(authority.context, lease, authority.signal) })), true);
      if (!current.selected.request) throw error;
      return { ...recovered, lease: current.lease, outcome: readRemoteWorkerRuntimeInstallOutcome(recovered.evidence.record.outcomeHex,
        current.selected.request, current.selected.history) };
    } catch { throw error; }
  }
}
