import { sha256BytesHex } from "./sha256.js";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint } from "./remote-worker-cell-mounted-workspace.js";
import { readRemoteWorkerCellObjectInventory, type RemoteWorkerCellObjectInventoryObservation } from "./remote-worker-cell-object-inventory.js";

export const REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES = 1_000_608;
/** Host file charges bound to this result's checkpoint and retained disk plan;
 * guest allocation and other pool objects are accounted for separately. */
export interface RemoteWorkerRuntimeBackingCounts {
  readonly backingFileBytes: number;
  readonly backingAllocatedBytes: number;
  readonly journalBytes: number;
  readonly journalAllocatedBytes: number;
  readonly hostFileAllocatedBytes: number;
}
/** A projection of an independently authorized request, not a worker approval.
 * The protected execution owner must retain this before sending executable
 * bytes. No command, environment, credential, or raw output belongs here. */
export interface RemoteWorkerRuntimeResultExpectation {
  readonly nonce: string;
  readonly requestSha256: string;
  readonly checkpointSha256: string;
  readonly runtimeBundleSha256: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxInventoryEntries: number;
}
const FLAG_NAMES = ["bindingVerified", "runtimeBundleVerified", "protectedWorkspaceVerified", "inventoryVerified",
  "terminatedDescendants", "zeroProcessesVerified", "outputDrained", "captureAttempted", "captureVerified",
  "appContainerVerified", "launchFilesVerified", "processImageVerified", "stdinComplete", "stdoutTruncated", "stderrTruncated"] as const;
export interface RemoteWorkerRuntimeResult {
  readonly resultSha256: string;
  readonly byteLength: number;
  readonly flags: Readonly<Record<typeof FLAG_NAMES[number], boolean>>;
  readonly end: "exited" | "cancelled" | "wall_limit" | "output_limit" | "launch_failed" | "control_failed";
  readonly error: number;
  readonly exitCode: number;
  readonly processId: number;
  readonly configuredCpuRate: number;
  readonly totalProcesses: number;
  readonly peakActiveProcesses: number;
  readonly captureError: number;
  readonly peakJobMemoryBytes: number;
  readonly cpuTime100ns: number;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly runtimeBundleSha256: string;
  readonly inventory: RemoteWorkerCellObjectInventoryObservation | null;
  readonly backing: RemoteWorkerRuntimeBackingCounts | null;
}
const refused = () => new TypeError("Native runtime result does not match independently retained execution authority.");
const EXPECTATION_KEYS = ["nonce", "requestSha256", "checkpointSha256", "runtimeBundleSha256", "maxInputBytes", "maxOutputBytes", "maxInventoryEntries"] as const;
export function normalizeRemoteWorkerRuntimeResultExpectation(input: unknown): RemoteWorkerRuntimeResultExpectation {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== EXPECTATION_KEYS.length || EXPECTATION_KEYS.some(key => !properties[key]?.enumerable || !("value" in properties[key]))) throw refused();
  const value = Object.fromEntries(EXPECTATION_KEYS.map(key => [key, properties[key]!.value])) as Record<string, unknown>;
  for (const key of EXPECTATION_KEYS.slice(0, 4)) if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key]) || /^0+$/u.test(value[key])) throw refused();
  for (const [key, min, max] of [["maxInputBytes", 0, 1048576], ["maxOutputBytes", 1, 67108864], ["maxInventoryEntries", 1, 20000]] as const) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw refused();
  }
  return Object.freeze(value) as unknown as RemoteWorkerRuntimeResultExpectation;
}

/** Decodes GCRRS001, with the same canonical bounds as the native owner.
 * Valid accounting is distinct from workload success and grants no readiness,
 * cleanup, retry, or external-effect authority. The caller supplies protected
 * history and expectation separately from the untrusted result. */
export function readRemoteWorkerRuntimeResult(input: unknown, suppliedExpectation: unknown,
  suppliedHistory: RemoteWorkerCellProvisioningExchange): RemoteWorkerRuntimeResult {
  if (typeof input !== "string" || input.length < 512 || input.length > REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES * 2 ||
      input.length % 2 || !/^[0-9a-f]+$/u.test(input)) throw refused();
  const expected = normalizeRemoteWorkerRuntimeResultExpectation(suppliedExpectation);
  const history = normalizeRemoteWorkerCellProvisioningExchange(suppliedHistory);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  const checkpoint = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords[1]);
  if (checkpoint.recordSha256 !== expected.checkpointSha256) throw refused();
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer), u32 = (offset: number) => view.getUint32(offset, true);
  const hex = (start: number, end: number) => input.slice(start * 2, end * 2);
  const u64 = (offset: number) => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refused();
    return Number(value);
  };
  const packed = u32(104), end = u32(108), count = u32(216);
  if (hex(0, 8) !== "4743525253303031" || hex(8, 40) !== expected.nonce || hex(40, 72) !== expected.requestSha256 ||
      hex(72, 104) !== expected.checkpointSha256 || packed > 0xffff || !(packed & 1) || end > 5 ||
      u32(140) !== 0 || u32(252) !== 0 || count > expected.maxInventoryEntries) throw refused();
  const flags = Object.freeze(Object.fromEntries(FLAG_NAMES.map((name, bit) => [name, !!(packed & (1 << bit))]))) as RemoteWorkerRuntimeResult["flags"];
  const configuredCpuRate = u32(124), processId = u32(120), captureError = u32(136);
  const peakJobMemoryBytes = u64(144), cpuTime100ns = u64(152), stdinBytes = u64(160), stdoutBytes = u64(168), stderrBytes = u64(176);
  const runtimeBundleSha256 = hex(184, 216);
  if (configuredCpuRate > 10000 || stdinBytes > expected.maxInputBytes || stdoutBytes + stderrBytes > expected.maxOutputBytes ||
      (flags.captureVerified && (!flags.captureAttempted || !flags.zeroProcessesVerified || !flags.outputDrained || captureError !== 0)) ||
      (flags.runtimeBundleVerified ? runtimeBundleSha256 !== expected.runtimeBundleSha256 : /[^0]/u.test(runtimeBundleSha256))) throw refused();
  let inventory: RemoteWorkerCellObjectInventoryObservation | null = null;
  if (flags.inventoryVerified) {
    if (!processId || !flags.appContainerVerified || !flags.launchFilesVerified || !flags.processImageVerified || !flags.captureVerified ||
        !flags.runtimeBundleVerified || !flags.protectedWorkspaceVerified || bytes.length !== 608 + 1000 * Math.ceil(count / 20)) throw refused();
    const chunks: string[] = [];
    for (let offset = 608; offset < bytes.length; offset += 1000) chunks.push(hex(offset, offset + 1000));
    inventory = readRemoteWorkerCellObjectInventory(hex(256, 608), chunks, history);
    if (inventory.connectionNonceHex !== expected.nonce || inventory.entries.length !== count) throw refused();
  } else if (count !== 0 || bytes.length !== 256) throw refused();
  let backing: RemoteWorkerRuntimeBackingCounts | null = null;
  if (packed & 0x8000) {
    const backingFileBytes = u64(220), backingAllocatedBytes = u64(228), journalBytes = u64(236), journalAllocatedBytes = u64(244);
    const hostFileAllocatedBytes = backingAllocatedBytes + journalAllocatedBytes;
    if (!inventory || backingFileBytes < history.plan.virtualDiskBytes || backingAllocatedBytes < backingFileBytes ||
        backingAllocatedBytes > history.plan.reservedDiskBytes || journalBytes !== 21 * 1024 ||
        journalAllocatedBytes < journalBytes || journalAllocatedBytes > 65536 || !Number.isSafeInteger(hostFileAllocatedBytes)) throw refused();
    backing = Object.freeze({ backingFileBytes, backingAllocatedBytes, journalBytes, journalAllocatedBytes, hostFileAllocatedBytes });
  } else if (/[^0]/u.test(hex(220, 252))) throw refused();
  const domain = new TextEncoder().encode("goatcitadel.worker-runtime-result.v1\0"), hashInput = new Uint8Array(domain.length + bytes.length);
  hashInput.set(domain); hashInput.set(bytes, domain.length);
  return Object.freeze({ resultSha256: sha256BytesHex(hashInput), byteLength: bytes.length, flags,
    end: (["exited", "cancelled", "wall_limit", "output_limit", "launch_failed", "control_failed"] as const)[end]!,
    error: u32(112), exitCode: u32(116), processId, configuredCpuRate, totalProcesses: u32(128), peakActiveProcesses: u32(132), captureError,
    peakJobMemoryBytes, cpuTime100ns, stdinBytes, stdoutBytes, stderrBytes, runtimeBundleSha256, inventory, backing });
}
