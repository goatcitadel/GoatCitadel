import { canonicalJsonString, normalizeRemoteWorkerNativeCapacityLayout, remoteWorkerCellCanonicalSha256,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES, type RemoteWorkerNativePoolSnapshot } from "@goatcitadel/contracts";
import { withWindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
import type { WindowsWorkerAssignmentCapacityInput } from "./worker-windows-assignment-capacity.js";
import { readWorkerNativePoolOnLease, readWorkerNativePoolCleanupOnLease } from "./worker-native-pool-client.js";
import { readWindowsAssignmentCleanupOnLease } from "./worker-windows-assignment-cleanup.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { exchangeWorkerCellProvisioning } from "./worker-cell-provisioning-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody,
  type WindowsWorkerPoolCapacityRequest } from "./worker-windows-cell-provisioning.js";
import { retainWorkerNativePoolCapacityCapture } from "./worker-native-capacity-delivery.js";
import { deliverWorkerNativePoolCapacityOnConnection } from "./worker-native-capacity-page-client.js";

export interface WindowsWorkerAssignmentPoolCapacityInput extends WindowsWorkerAssignmentCapacityInput {
  /** Independently retained by the installed capture coordinator. Neither
   * worker configuration nor submitted source bytes establish these bindings. */
  readonly capture: Omit<WindowsWorkerPoolCapacityRequest, "pool">;
  readonly phase: "provisioning" | "ready";
}
const refused = () => new Error("Native assignment capture differs from its protected pool or retained bindings.");
function assertPool(expected: RemoteWorkerNativePoolSnapshot, current: RemoteWorkerNativePoolSnapshot) {
  if (expected.leaseRevision > current.leaseRevision ||
      canonicalJsonString({ ...expected, leaseRevision: current.leaseRevision }) !== canonicalJsonString(current)) throw refused();
}

/** Stable authority covers capture and local retention. Renewable per-request
 * authority covers upload. Installed collection and independently registered
 * Gateway expectations remain mandatory; this function creates neither. */
export async function observeWindowsWorkerAssignmentPoolCapacity(supplied: WindowsWorkerAssignmentPoolCapacityInput) {
  const input = Object.freeze({ ...supplied }), phase = input.phase;
  const layout = normalizeRemoteWorkerNativeCapacityLayout(input.capture.layout);
  const captureNonce = input.capture.captureNonce, referencesJson = input.capture.referencesJson;
  if (!["provisioning", "ready"].includes(phase) || typeof captureNonce !== "string" || !/^[0-9a-f]{64}$/u.test(captureNonce) || /^0+$/u.test(captureNonce) ||
      typeof referencesJson !== "string" || Buffer.byteLength(referencesJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw refused();
  const referencesSha256 = remoteWorkerCellCanonicalSha256(JSON.parse(referencesJson));
  return withWindowsWorkerAssignmentAuthority(input, 600000, async authority => {
    const retained = await authority.withStableLease(async (lease, check) => {
      const readPool = () => readWorkerNativePoolOnLease({ context: authority.context, lease, signal: authority.signal, assertCurrent: check });
      const pool = await readPool();
      const assertCurrent = async (expected: RemoteWorkerNativePoolSnapshot) => { await check(); assertPool(expected, await readPool()); };
      return retainWorkerNativePoolCapacityCapture({ pool, captureNonce, state: input.state, signal: authority.signal, assertCurrent,
        capture: async (expected, authorize) => {
          const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal: authority.signal,
            assertCurrent: check, imageGuard: input.imageGuard });
          const history = phase === "ready"
            ? (await exchangeWorkerCellCapacity(authority.context, lease, { kind: "cell.capacity.snapshot" }, authority.signal)).history
            : await exchangeWorkerCellProvisioning(authority.context, lease, { kind: "cell.provisioning.snapshot" }, authority.signal);
          await authorize();
          const driver = createWindowsWorkerCellProvisioning({ parentPath: custody.parentPath, controllerService: true,
            wallMs: 60000, signal: authority.signal, assertCurrent: check, imageGuard: input.imageGuard,
            readPoolCleanup: signal => readWorkerNativePoolCleanupOnLease({ context: authority.context, lease, signal, assertCurrent: check }),
            readCleanup: (expectedHistory, signal) => readWindowsAssignmentCleanupOnLease({
              context: authority.context, lease, signal, assertCurrent: check, expectedHistory }) });
          const result = await driver.observePoolCapacity(history, { pool: expected, layout, captureNonce, referencesJson }, authorize);
          await authorize();
          return canonicalJsonString({ layout: result.delivery.layout, window: result.delivery.window, source: result.delivery.source });
        } });
    });
    if (canonicalJsonString(retained.layout) !== canonicalJsonString(layout) || retained.window.referencesSha256 !== referencesSha256)
      throw refused();
    const result = await deliverWorkerNativePoolCapacityOnConnection({ context: authority.context, currentLease: authority.lease,
      leaseOwner: { withCurrentLease: authority.withCurrentLease }, pool: retained.pool, captureNonce, state: input.state, signal: authority.signal,
      assertCurrent: expected => authority.withStableLease(async (lease, check) => {
        assertPool(expected, await readWorkerNativePoolOnLease({ context: authority.context, lease, signal: authority.signal, assertCurrent: check }));
      }),
      capture: async () => { throw new Error("Durably retained native capture is missing; refuse to rescan during upload."); } });
    return Object.freeze({ ...result, lease: authority.lease() });
  }, true);
}
