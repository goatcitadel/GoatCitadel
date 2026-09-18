import { accountRemoteWorkerCellCapacityInventory, evaluateRemoteWorkerCellCapacityAdmission,
  hashRemoteWorkerInstallCapacityCapture, normalizeRemoteWorkerInstallCapacityBinding,
  normalizeRemoteWorkerNativePoolCapacityWindow, readRemoteWorkerNativePoolCapacityResponse,
  remoteWorkerCellCanonicalSha256, REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerInstallCapacityBinding, type RemoteWorkerNativePoolCapacityWindow } from "@goatcitadel/contracts";
import { RemoteWorkerCellConflictError, type RemoteWorkerCellRecord } from "./remote-worker-cell-repo.js";
import { assertRuntimeInstallFitsCapturedCapacity } from "./remote-worker-runtime-install-capacity.js";
import type { RemoteWorkerRuntimeInstallRepository } from "./remote-worker-runtime-install-repo.js";

export interface RuntimeInstallPoolCapture {
  readonly responseHex: string;
  /** Independently retained by the authenticated capture owner, never derived
   * from the submitted response or an older accepted observation. */
  readonly window: RemoteWorkerNativePoolCapacityWindow;
  readonly referencesJson: string;
  readonly binding: RemoteWorkerInstallCapacityBinding;
}
const refused = () => new RemoteWorkerCellConflictError("Installation capture requires its complete current pool, reviewed request and reserved limits.");
export function snapshotRuntimeInstallPoolCapture(input: RuntimeInstallPoolCapture): RuntimeInstallPoolCapture {
  const responseHex = input.responseHex, referencesJson = input.referencesJson;
  if (typeof responseHex !== "string" || responseHex.length < 2624 ||
      responseHex.length > REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES * 2 || responseHex.length % 2 || !/^[a-f0-9]+$/u.test(responseHex) ||
      typeof referencesJson !== "string" || Buffer.byteLength(referencesJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw refused();
  return Object.freeze({ responseHex, referencesJson, window: normalizeRemoteWorkerNativePoolCapacityWindow(input.window),
    binding: normalizeRemoteWorkerInstallCapacityBinding(input.binding) });
}

/** Canonical validation only: the enclosing owner must still retain a live
 * authenticated capture window, exclusion, current policy and reservation
 * lifetime. No persistent capacity revision or installation state is advanced. */
export function validateRuntimeInstallPoolCapture(
  baseline: ReturnType<RemoteWorkerRuntimeInstallRepository["readPoolAdmissionMaterialForAssignment"]>,
  cell: RemoteWorkerCellRecord, capture: RuntimeInstallPoolCapture) {
  const bytes = Buffer.from(capture.responseHex, "hex"), binding = capture.binding;
  if (binding.installationNonce !== baseline.request.nonce || binding.requestSha256 !== baseline.requestSha256 ||
      binding.connectionNonceHex !== capture.window.connectionNonceHex || binding.byteLength !== bytes.length ||
      binding.captureSha256 !== hashRemoteWorkerInstallCapacityCapture(bytes)) throw refused();
  const delivery = readRemoteWorkerNativePoolCapacityResponse(capture.responseHex, baseline.pool, baseline.layout,
    capture.window, JSON.parse(capture.referencesJson) as unknown);
  const capacity = { ...baseline.capacity, inventory: delivery.inventory, inventoryBinding: delivery.inventoryBinding };
  assertRuntimeInstallFitsCapturedCapacity(baseline.history, baseline.request.runtimeBundle, capacity);
  const accounting = accountRemoteWorkerCellCapacityInventory(delivery.inventory, delivery.inventoryBinding);
  const evaluation = evaluateRemoteWorkerCellCapacityAdmission({ ...capacity.observation, footprint: accounting.footprint,
    peakFileCount: Math.max(capacity.observation.peakFileCount,
      accounting.hostFileCount + accounting.guestFileCount + baseline.request.runtimeBundle.files.length) }, cell);
  if (evaluation.decision !== "accept") throw refused();
  return Object.freeze({ binding, window: capture.window, inventoryBinding: delivery.inventoryBinding,
    baselineSha256: remoteWorkerCellCanonicalSha256(baseline), evaluation });
}
