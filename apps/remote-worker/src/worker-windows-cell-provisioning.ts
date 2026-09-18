import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRemoteWorkerCellProvisioningSuccessor, normalizeRemoteWorkerCellProvisioningPlan,
  readRemoteWorkerCellProvisioningCheckpoint,
  normalizeRemoteWorkerCellProvisioningExchange, deriveRemoteWorkerCellVolumeAnchor,
  readRemoteWorkerCellVolumeCheckpoint, assertRemoteWorkerCellVolumeSuccessor,
  REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION, readRemoteWorkerCellFormatCheckpoint,
  assertRemoteWorkerCellFormatSuccessor, type RemoteWorkerCellFormatCheckpoint,
  REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION, readRemoteWorkerCellProtectionCheckpoint,
  assertRemoteWorkerCellProtectionSuccessor, type RemoteWorkerCellProtectionCheckpoint,
  REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION, readRemoteWorkerCellMountCheckpoint,
  assertRemoteWorkerCellMountSuccessor, type RemoteWorkerCellMountCheckpoint,
  REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION, readRemoteWorkerCellMountedWorkspaceCheckpoint,
  assertRemoteWorkerCellMountedWorkspaceSuccessor, type RemoteWorkerCellMountedWorkspaceCheckpoint,
  type RemoteWorkerCellVolumeCheckpoint, type RemoteWorkerCellProvisioningExchange,
  type RemoteWorkerCellProvisioningCheckpoint, type RemoteWorkerCellProvisioningPlan,
  type RemoteWorkerCellProvisioningRecovery,
  type RemoteWorkerCellObjectInventoryObservation,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultReceipt,
  normalizeRemoteWorkerRuntimeResultExpectation, canonicalJsonString,
  remoteWorkerCellCanonicalSha256,
  encodeRemoteWorkerRuntimeInstallRequest, decodeRemoteWorkerRuntimeInstallRequest,
  readRemoteWorkerRuntimeInstallOutcome, type RemoteWorkerRuntimeInstallOutcome, type RemoteWorkerRuntimeInstallRequest,
  encodeRemoteWorkerRuntimeCleanup,
  normalizeRemoteWorkerNativePoolSnapshot, normalizeRemoteWorkerNativeCapacityLayout,
  captureRemoteWorkerNativePoolCapacityResponse, REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerNativePoolSnapshot, type RemoteWorkerNativeCapacityLayout, type RemoteWorkerNativePoolCapacityDelivery,
} from "@goatcitadel/contracts";
import { WindowsRuntimeHelperParent } from "./worker-windows-runtime-helper.js";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
import { createWindowsInstallationCapture, type WindowsWorkerInstallationCaptureAdmission } from "./worker-windows-installation-capture.js";
import { createWorkerControllerAttestationRelay } from "./worker-controller-attestation-relay.js";
import { encodeWindowsAssignmentCleanupAdmission, type readWindowsAssignmentCleanupOnLease } from "./worker-windows-assignment-cleanup.js";
import { encodeWindowsWorkerPoolHistory } from "./worker-windows-pool-history.js";
import { encodeWindowsWorkerPoolCleanup } from "./worker-windows-pool-cleanup.js";
import type { RemoteWorkerNativePoolCleanupSnapshot } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch, type WindowsRuntimeDispatchRequest } from "@goatcitadel/contracts/remote-worker-runtime-node";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";
import { decodeWindowsWorkerCellCapacity, decodeWindowsWorkerCellBackingCapacity, decodeWindowsWorkerCellObjectInventory,
  type WindowsWorkerCellCapacityObservation, type WindowsWorkerCellCapacityResult,
  type WindowsWorkerCellBackingCapacityObservation, type WindowsWorkerCellBackingCapacityResult,
  type WindowsWorkerCellObjectInventoryResult } from "./worker-windows-cell-capacity.js";

/** Trusted composition only. Registry/model data cannot select an executable or
 * provide parent custody. The native owner rechecks the actual protected parent. */
export interface WindowsWorkerCellProvisioningImageGuard {
  pinCellProvisioningExecutor(): { readonly executorPath: string; readonly lease: object };
}
export interface WindowsWorkerCellProvisioningOptions {
  readonly parentPath: string;
  readonly wallMs: number;
  readonly signal: AbortSignal;
  /** Measurement/install callbacks run with local writers held. Supply a
   * read-only check from a stable lease window, not a renewing state writer. */
  readonly assertCurrent: () => Promise<void>;
  /** Trusted installed-service composition only; this never falls back to the
   * direct component path when controller admission or transport fails. */
  readonly controllerService?: boolean;
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
  /** Read-only under the caller's stable lease and this driver's writer pause. */
  readonly readCleanup?: (history: RemoteWorkerCellProvisioningExchange, signal: AbortSignal) => ReturnType<typeof readWindowsAssignmentCleanupOnLease>;
  readonly readPoolCleanup?: (signal: AbortSignal) => Promise<RemoteWorkerNativePoolCleanupSnapshot>;
}
export interface WindowsWorkerCellRuntimeRequest {
  /** Exact reviewed request; the independent expectation comes from admission. */
  readonly request: WindowsRuntimeDispatchRequest;
  readonly expected: RemoteWorkerRuntimeResultExpectation;
  readonly owner: WindowsRuntimeParentSessionOwner;
}
export interface WindowsWorkerPoolCapacityRequest {
  readonly pool: RemoteWorkerNativePoolSnapshot;
  readonly layout: RemoteWorkerNativeCapacityLayout;
  readonly captureNonce: string;
  /** Immutable serialization from the trusted shared-reference owner. */
  readonly referencesJson: string;
}
/** Final read-only Gateway validation while the native controller still waits
 * for its terminal acknowledgement. Do not publish the canonical outcome here;
 * publication follows clean helper exit. Never wait for human approval. */
export type WindowsWorkerInstallationFinish = (terminal: Readonly<{
  requestSha256: string; nativeReceiptHex: string; outcomeHex: string;
}>, signal: AbortSignal) => Promise<void>;
const leases = new Set<object>();
const requireNative = createRequire(import.meta.url);
const refused = () => new Error("Native cell provisioning was refused or interrupted; retained evidence requires reconciliation.");

export interface WindowsWorkerCellControllerCustody {
  readonly schemaVersion: "goatcitadel.worker-windows-cell-controller-custody.v1";
  readonly parentPath: string;
  readonly parentIdentityHex: string;
  readonly nativeDirectoryIdentityHex: string;
  readonly controllerSha256: string;
  readonly provisioningSha256: string;
  readonly custodySha256: string;
}

/** Decode only; this is not an installed-identity or execution grant. Startup
 * must obtain these bytes from the pinned helper through the read owner below. */
export function decodeWindowsWorkerCellControllerCustody(bytes: Buffer): WindowsWorkerCellControllerCustody {
  if (!Buffer.isBuffer(bytes) || bytes.length < 133 || bytes.length > 8324 ||
      !bytes.subarray(0, 8).equals(Buffer.from("GCCINF01")) || bytes.readUInt32LE(8) !== bytes.length - 132 ||
      !bytes.subarray(12, 20).equals(Buffer.from("GCCUST01"))) throw refused();
  const parentPath = bytes.subarray(132).toString("utf8");
  if (!Buffer.from(parentPath, "utf8").equals(bytes.subarray(132)) ||
      !/^[A-Za-z]:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells$/u.test(parentPath)) throw refused();
  const controllerSha256 = bytes.subarray(20, 52).toString("hex");
  const provisioningSha256 = bytes.subarray(52, 84).toString("hex");
  const nativeDirectoryIdentityHex = bytes.subarray(84, 108).toString("hex");
  const parentIdentityHex = bytes.subarray(108, 132).toString("hex");
  if (/^0+$/u.test(controllerSha256) || /^0+$/u.test(provisioningSha256) || controllerSha256 === provisioningSha256 ||
      nativeDirectoryIdentityHex === parentIdentityHex ||
      nativeDirectoryIdentityHex.slice(0, 16) !== parentIdentityHex.slice(0, 16) ||
      [nativeDirectoryIdentityHex, parentIdentityHex].some((value) => /^0+$/u.test(value.slice(0, 16)) || /^0+$/u.test(value.slice(16)))) throw refused();
  return Object.freeze({ schemaVersion: "goatcitadel.worker-windows-cell-controller-custody.v1", parentPath,
    parentIdentityHex, nativeDirectoryIdentityHex, controllerSha256, provisioningSha256,
    custodySha256: createHash("sha256").update(bytes.subarray(12, 132)).digest("hex") });
}

function pinProvisioningHelper(imageGuard?: WindowsWorkerCellProvisioningImageGuard) {
  const guard = imageGuard ?? requireNative(fileURLToPath(new URL(
    "../native/GoatCitadelRemoteWorkerImageGuard.node", import.meta.url,
  ))) as WindowsWorkerCellProvisioningImageGuard;
  const pinned = guard.pinCellProvisioningExecutor();
  if (!pinned || typeof pinned.executorPath !== "string" || !path.isAbsolute(pinned.executorPath) ||
      path.basename(pinned.executorPath) !== "GoatCitadelRemoteWorkerCellProvisioning.exe" ||
      !pinned.lease || typeof pinned.lease !== "object") throw refused();
  return pinned;
}

/** Read the fixed installed custody before planning native creation. No caller
 * path or input is sent; only the admitted helper can return a snapshot. */
export async function readWindowsWorkerCellControllerCustody(
  options: Pick<WindowsWorkerCellProvisioningOptions, "signal" | "wallMs" | "assertCurrent" | "imageGuard">,
): Promise<WindowsWorkerCellControllerCustody> {
  const { signal: callerSignal, wallMs, assertCurrent, imageGuard } = options;
  if (process.platform !== "win32" || !Number.isSafeInteger(wallMs) || wallMs < 100 || wallMs > 10000 ||
      typeof assertCurrent !== "function") throw refused();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(wallMs)]);
  await whileCurrent(assertCurrent, signal);
  const pinned = pinProvisioningHelper(imageGuard);
  leases.add(pinned.lease);
  try {
    signal.throwIfAborted();
    const child = spawn(pinned.executorPath, ["--controller-custody"], { cwd: path.dirname(pinned.executorPath),
      windowsHide: true, shell: false, env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"] });
    let failed = false, total = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      if (failed) return;
      failed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      child.stdin.destroy();
    };
    const closed = new Promise<boolean>((resolve) => child.once("close", (code, exitSignal) => resolve(code === 0 && !exitSignal)));
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", stop); child.stdin.on("error", stop); child.stdout.on("error", stop);
    child.stderr.on("error", stop); child.stderr.on("data", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > 8324) { stop(); return; }
      chunks.push(Buffer.from(chunk));
    });
    try {
      if (signal.aborted) stop(); else child.stdin.end();
      if (!(await closed) || failed || signal.aborted) throw refused();
      const snapshot = decodeWindowsWorkerCellControllerCustody(Buffer.concat(chunks, total));
      await whileCurrent(assertCurrent, signal);
      return snapshot;
    } finally {
      signal.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null) stop();
      await closed;
    }
  } finally { leases.delete(pinned.lease); }
}

/** Fixed, bounded private protocol. Native GUID bytes are not display UUIDs. */
export function encodeWindowsWorkerCellProvisioning(
  input: RemoteWorkerCellProvisioningPlan, parentPath: string, wallMs: number, preparedRecordHex?: string,
  volume?: true | RemoteWorkerCellProvisioningExchange, format = false, protection = false, mount = false, mountedWorkspace = false, capacity = false, backingCapacity = false, inventory = false, runtime = false, installation = false, installationRecovery = false, poolCapacity = false,
): Buffer {
  const plan = normalizeRemoteWorkerCellProvisioningPlan(input);
  const combinedInstallation = installation && poolCapacity && !installationRecovery;
  const observingCapacity = capacity || backingCapacity || inventory || runtime || installation || poolCapacity;
  if (typeof format !== "boolean" || typeof protection !== "boolean" || typeof mount !== "boolean" || typeof mountedWorkspace !== "boolean" ||
      typeof capacity !== "boolean" || typeof backingCapacity !== "boolean" || typeof inventory !== "boolean" || typeof runtime !== "boolean" ||
      typeof installation !== "boolean" || typeof installationRecovery !== "boolean" || (installationRecovery && !installation) ||
      typeof poolCapacity !== "boolean" || Number(capacity) + Number(backingCapacity) + Number(inventory) + Number(runtime) + Number(installation) + Number(poolCapacity) - Number(combinedInstallation) > 1 ||
      (observingCapacity && (!mountedWorkspace || !volume || volume === true || preparedRecordHex === undefined)) ||
      (format && volume === undefined) || (protection && !format) || (mount && !protection) || (mountedWorkspace && !mount)) throw refused();
  let volumeRecords: readonly string[] = [], formatRecords: readonly string[] = [], protectionRecords: readonly string[] = [];
  let creationRecords: readonly string[] = [], mountRecords: readonly string[] = [], mountedWorkspaceRecords: readonly string[] = [];
  if (volume !== undefined) {
    if (plan.virtualDiskBytes < 64 * 1024 * 1024) throw refused();
    if (volume === true) { if (preparedRecordHex !== undefined) throw refused(); }
    else {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(volume);
      if (preparedRecordHex === undefined || canonical.records[0] !== preparedRecordHex || canonical.volumeRecords?.length !== 6 ||
          JSON.stringify(canonical.plan) !== JSON.stringify(plan) ||
          (format ? canonical.formatRecords?.length !== 2 : Boolean(canonical.formatRecords?.length)) ||
          (protection ? canonical.protectionRecords?.length !== 2 : Boolean(canonical.protectionRecords?.length)) ||
          (mount ? canonical.mountRecords?.length !== 4 : Boolean(canonical.mountRecords?.length)) ||
          (mountedWorkspace ? canonical.mountedWorkspaceRecords?.length !== 2 : Boolean(canonical.mountedWorkspaceRecords?.length))) throw refused();
      volumeRecords = canonical.volumeRecords;
      formatRecords = canonical.formatRecords ?? [];
      protectionRecords = canonical.protectionRecords ?? [];
      if (mount) { creationRecords = canonical.records; mountRecords = canonical.mountRecords!; }
      mountedWorkspaceRecords = canonical.mountedWorkspaceRecords ?? [];
    }
  }
  if (typeof parentPath !== "string" || !path.win32.isAbsolute(parentPath) || parentPath.includes("\0") ||
      !Number.isSafeInteger(wallMs) || wallMs < 100 || wallMs > (runtime ? 86400000 : observingCapacity ? 60000 : 600000)) throw refused();
  const parent = Buffer.from(parentPath, "utf8");
  if (!parent.length || parent.length > 8192 || parent.toString("utf8") !== parentPath) throw refused();
  const header = Buffer.alloc(20), bytes = Buffer.alloc(528);
  header.write("GCPROV01", 0, "ascii"); header.writeUInt32LE(combinedInstallation ? 21 : poolCapacity ? 20 : installationRecovery ? 19 : installation ? 18 : runtime ? 17 : inventory ? 16 : backingCapacity ? 15 : capacity ? 14 : (preparedRecordHex === undefined ? 1 : 2) + (mountedWorkspace ? 10 : mount ? 8 : protection ? 6 : format ? 4 : volume ? 2 : 0), 8);
  header.writeUInt32LE(wallMs, 12); header.writeUInt32LE(parent.length, 16);
  for (const [offset, value] of [[0, plan.assignmentBindingSha256], [32, plan.profileSha256],
    [64, plan.diskIdentifierHex], [96, plan.parentIdentityHex]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 80); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 88);
  bytes.write(plan.cellName, 120, "ascii"); bytes.write(plan.ownerSid, 160, "ascii"); bytes.write(plan.controllerSid, 344, "ascii");
  let anchor = Buffer.alloc(0);
  if (preparedRecordHex !== undefined) {
    const first = readRemoteWorkerCellProvisioningCheckpoint(preparedRecordHex);
    assertRemoteWorkerCellProvisioningSuccessor(plan, undefined, first);
    anchor = Buffer.from(first.journalIdentityHex + first.recordSha256, "hex");
  }
  return Buffer.concat([header, bytes, parent, anchor, ...volumeRecords.map((record) => Buffer.from(record, "hex")),
    ...formatRecords.map((record) => Buffer.from(record, "hex")), ...protectionRecords.map((record) => Buffer.from(record, "hex")),
    ...creationRecords.map((record) => Buffer.from(record, "hex")), ...mountRecords.map((record) => Buffer.from(record, "hex")),
    ...mountedWorkspaceRecords.map((record) => Buffer.from(record, "hex"))]);
}

async function whileCurrent<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(refused()); });
  signal.addEventListener("abort", cancel, { once: true });
  try { if (signal.aborted) cancel(); return await Promise.race([Promise.resolve().then(work), interrupted]); }
  finally { signal.removeEventListener("abort", cancel); }
}

/** Holds the exact image lease until its owned child closes. Never retries an
 * uncertain creation, activates a backend, or treats resource records as ready. */
export function createWindowsWorkerCellProvisioning(options: WindowsWorkerCellProvisioningOptions) {
  const { parentPath, wallMs, signal: callerSignal, assertCurrent, imageGuard, controllerService, readCleanup, readPoolCleanup } = options;
  if (controllerService !== undefined && typeof controllerService !== "boolean") throw refused();
  const call = async (input: RemoteWorkerCellProvisioningPlan, preparedRecordHex: string | undefined,
    commit?: (recordHex: string) => Promise<string>, volume?: true | RemoteWorkerCellProvisioningExchange,
    authorizeVolume?: () => Promise<void>, format = false, protection = false, mount = false, mountedWorkspace = false, capacity = false, backingCapacity = false, inventory = false,
    runtime?: { readonly bytes: Uint8Array; readonly expected: RemoteWorkerRuntimeResultExpectation; readonly owner: WindowsRuntimeParentSessionOwner },
    installation?: { readonly request: RemoteWorkerRuntimeInstallRequest; readonly requestSha256: string; readonly bytes: Uint8Array; readonly authorize: () => Promise<void>; readonly recovery: boolean; readonly beforeFinish?: WindowsWorkerInstallationFinish; readonly captureAdmission?: WindowsWorkerInstallationCaptureAdmission },
    activitySignal?: AbortSignal, poolCapture?: WindowsWorkerPoolCapacityRequest): Promise<{
      readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
      readonly protectionRecords: readonly string[]; readonly mountRecords: readonly string[]; readonly mountedWorkspaceRecords: readonly string[];
      readonly capacity?: WindowsWorkerCellCapacityResult;
      readonly backingCapacity?: WindowsWorkerCellBackingCapacityResult;
      readonly inventory?: WindowsWorkerCellObjectInventoryResult;
      readonly poolCapacity?: { readonly delivery: RemoteWorkerNativePoolCapacityDelivery; readonly nativeReceiptHex: string };
      readonly runtime?: RemoteWorkerRuntimeResultReceipt;
      readonly installation?: { readonly requestSha256: string; readonly nativeReceiptHex: string; readonly outcomeHex: string; readonly outcome: RemoteWorkerRuntimeInstallOutcome };
    }> => {
    const plan = normalizeRemoteWorkerCellProvisioningPlan(input);
    const combinedInstallation = Boolean(installation && poolCapture);
    if (combinedInstallation && (installation?.recovery || !installation?.captureAdmission || !authorizeVolume)) throw refused();
    const observingCapacity = capacity || backingCapacity || inventory || Boolean(poolCapture);
    const protectedExchange = observingCapacity || Boolean(runtime) || Boolean(installation);
    if (volume !== undefined && (!controllerService || (volume === true && (!commit || !authorizeVolume)))) throw refused();
    if (protectedExchange && (commit || typeof (installation ? installation.authorize : authorizeVolume) !== "function")) throw refused();
    let bytes = encodeWindowsWorkerCellProvisioning(plan, parentPath, wallMs, preparedRecordHex, volume, format, protection, mount, mountedWorkspace, capacity, backingCapacity, inventory, Boolean(runtime), Boolean(installation), installation?.recovery ?? false, Boolean(poolCapture));
    const maximum = mountedWorkspace ? 21 : mount ? 19 : protection ? 15 : format ? 13 : volume ? 11 : 5;
    // Twenty-one checkpoints, at most 256 authority challenges, and one receipt.
    // Keep the existing limits for earlier protocol operations.
    const maximumOutputBytes = installation ? 21 * 1029 + 65536 * 105 + 357 + 21 + (combinedInstallation ?
      37 + 149 + 5 + REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES + 65536 * (149 + 465) + 256 * 45 : 0) :
      mountedWorkspace ? 21 * 1029 + 256 * 45 + 21 + (poolCapture ? 5 + REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES : inventory ? 357 + 1000 * 1005 : backingCapacity ? 429 : capacity ? 357 : 0) : volume ? 32768 : 8192;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([callerSignal, cancellation.signal, activitySignal ?? AbortSignal.timeout(wallMs)]);
    let captureBridge: ReturnType<typeof createWindowsInstallationCapture> | undefined;
    let attestationRelay: ReturnType<typeof createWorkerControllerAttestationRelay> | undefined;
    signal.throwIfAborted();
    if (process.platform !== "win32") throw refused();
    await whileCurrent(assertCurrent, signal);
    const pinned = pinProvisioningHelper(imageGuard);
    leases.add(pinned.lease);
    let runtimeParent: WindowsRuntimeHelperParent | undefined;
    let finishRuntimeWriter: ((cleanupVerified: boolean) => void) | undefined;
    let runtimeLaunched = false, runtimeCleanupVerified = false;
    try {
      if (observingCapacity) {
        if (!readCleanup || !readPoolCleanup || !volume || volume === true) throw refused();
        const cleanup = await readCleanup(volume, signal);
        await whileCurrent(assertCurrent, signal);
        if (canonicalJsonString(cleanup.exchange.history) !== canonicalJsonString(volume)) throw refused();
        const encoded = encodeRemoteWorkerRuntimeCleanup(cleanup.exchange);
        const admission = encodeWindowsAssignmentCleanupAdmission({ challenge: encoded.challenge, setSha256: encoded.setSha256, installations: cleanup.installations });
        const poolCleanup = await readPoolCleanup(signal);
        await whileCurrent(assertCurrent, signal);
        const pool = poolCleanup.pool;
        if (poolCapture && canonicalJsonString(pool) !== canonicalJsonString(poolCapture.pool)) throw refused();
        const poolBytes = encodeWindowsWorkerPoolHistory(pool, volume, poolCapture ? 20 : inventory ? 16 : backingCapacity ? 15 : 14, wallMs);
        const cleanupBytes = encodeWindowsWorkerPoolCleanup(poolCleanup, pool, encoded.challenge);
        const cleanupSize = Buffer.alloc(4); cleanupSize.writeUInt32LE(cleanupBytes.length);
        bytes = Buffer.concat([bytes, admission, Buffer.from(encoded.bytesHex, "hex"), poolBytes, cleanupSize, cleanupBytes]);
        if (poolCapture) bytes = Buffer.concat([bytes, Buffer.from(poolCapture.captureNonce, "hex")]);
        if (combinedInstallation) bytes = Buffer.concat([bytes, Buffer.from(remoteWorkerCellCanonicalSha256(JSON.parse(poolCapture!.referencesJson)), "hex")]);
      }
      if (installation) bytes = Buffer.concat([bytes, Buffer.from(installation.request.nonce + installation.requestSha256, "hex"), installation.bytes]);
      if (runtime) {
        finishRuntimeWriter = workerLocalStateActivity.beginExternalWriter();
        if (!volume || volume === true) throw refused();
        runtimeParent = await WindowsRuntimeHelperParent.open(runtime.bytes, runtime.expected, volume,
          { ...runtime.owner, timeoutMs: wallMs, signal: AbortSignal.any([signal, runtime.owner.signal]) });
        const bootstrap = runtimeParent.takeBootstrap();
        try { bytes = Buffer.concat([bytes, bootstrap]); } finally { bootstrap.fill(0); }
      }
      signal.throwIfAborted();
      const child = spawn(pinned.executorPath, controllerService ? ["--controller"] : [], { cwd: path.dirname(pinned.executorPath), windowsHide: true,
        shell: false, env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"] });
      runtimeLaunched = !!runtime;
      let failed = false, total = 0, pending = Buffer.alloc(0), receipt: Buffer | undefined;
      let poolResponseHex: string | undefined;
      let observation: WindowsWorkerCellCapacityObservation | undefined;
      let backingObservation: WindowsWorkerCellBackingCapacityObservation | undefined;
      let inventorySummary: WindowsWorkerCellCapacityObservation | undefined, inventoryBytes: Buffer | undefined;
      let objectObservation: RemoteWorkerCellObjectInventoryObservation | undefined;
      const inventoryChunks: Buffer[] = [];
      let processing = Promise.resolve();
      const checkpoints: RemoteWorkerCellProvisioningCheckpoint[] = [];
      const volumeCheckpoints: RemoteWorkerCellVolumeCheckpoint[] = [];
      const formatCheckpoints: RemoteWorkerCellFormatCheckpoint[] = [];
      const protectionCheckpoints: RemoteWorkerCellProtectionCheckpoint[] = [];
      const mountCheckpoints: RemoteWorkerCellMountCheckpoint[] = [];
      const workspaceCheckpoints: RemoteWorkerCellMountedWorkspaceCheckpoint[] = [];
      let volumeChecks = 0, authorizedVolumeCount = 0;
      let installationChecks = 0;
      let installationOutcome: { readonly outcomeHex: string; readonly outcome: RemoteWorkerRuntimeInstallOutcome } | undefined;
      const stop = () => {
        if (failed) return;
        failed = true; cancellation.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        child.stdin.destroy();
      };
      if (runtimeParent) void runtimeParent.completion.catch(stop);
      const closed = new Promise<boolean>((resolve) => child.once("close", (code, exitSignal) => resolve(code === 0 && !exitSignal)));
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", stop); child.stdin.on("error", stop); child.stdout.on("error", stop);
      child.stderr.on("error", stop); child.stderr.on("data", stop);
      const write = (value: Buffer, last = false) => new Promise<void>((resolve, reject) => {
        if (failed || signal.aborted) { reject(refused()); return; }
        const done = (error?: Error | null) => error ? reject(refused()) : resolve();
        if (last) child.stdin.end(value, done); else child.stdin.write(value, done);
      });
      if (combinedInstallation) {
        attestationRelay = createWorkerControllerAttestationRelay(write, signal, assertCurrent);
        captureBridge = createWindowsInstallationCapture(
          { nonce: installation!.request.nonce, requestSha256: installation!.requestSha256 }, poolCapture!,
          installation!.captureAdmission!, assertCurrent, signal, attestationRelay.transport);
      }
      const frame = async (kind: number, payload: Buffer) => {
        if (failed || receipt || ((observation || backingObservation || poolResponseHex) && kind !== 2) || (inventorySummary && kind !== 9 && kind !== 2)) throw refused();
        const count = checkpoints.length + volumeCheckpoints.length + formatCheckpoints.length + protectionCheckpoints.length + mountCheckpoints.length + workspaceCheckpoints.length;
        if (kind >= 15 && kind <= 18) {
          if (!captureBridge || installationOutcome || (kind === 15 ? count !== 0 || installationChecks !== 0 :
              count !== 21 || installationChecks < 1 || authorizedVolumeCount !== 21)) throw refused();
          const acknowledgement = await captureBridge.accept(kind, payload);
          if (acknowledgement) await write(acknowledgement);
          return;
        }
        if (kind === 2) {
          if (installation && !payload.readUInt32LE(0) && (count !== 21 || installationChecks < 2 || !installationOutcome)) throw refused();
          if (installation && !payload.readUInt32LE(0)) {
            captureBridge?.assertComplete();
            if (payload.readUInt32LE(4) !== 5 || payload.readUInt32LE(8) !== 0 || payload.readUInt32LE(12) !== 21) throw refused();
            await whileCurrent(assertCurrent, signal);
            await whileCurrent(installation.authorize, signal);
            if (!installation.recovery) {
              if (!installation.beforeFinish || !installationOutcome) throw refused();
              const terminal = Object.freeze({ requestSha256: installation.requestSha256,
                nativeReceiptHex: payload.toString("hex"), outcomeHex: installationOutcome.outcomeHex });
              await whileCurrent(() => installation.beforeFinish!(terminal, signal), signal);
              await whileCurrent(assertCurrent, signal);
            }
          }
          if (volume === true && payload.readUInt32LE(0) === 0 && (count !== maximum || authorizedVolumeCount !== count)) throw refused();
          const observed = observation ?? backingObservation ?? inventorySummary ?? poolResponseHex;
          if (observingCapacity && !combinedInstallation && (payload.readUInt32LE(0) ? observed : (!observed || count !== maximum || authorizedVolumeCount !== count))) throw refused();
          if (inventorySummary && inventoryBytes && volume && volume !== true)
            objectObservation = decodeWindowsWorkerCellObjectInventory(inventoryBytes, inventoryChunks, volume);
          receipt = payload;
          if (runtime && !payload.readUInt32LE(0) && (count !== 21 || authorizedVolumeCount !== count)) throw refused();
          if (volume === true || protectedExchange) await write(Buffer.alloc(0), true);
          return;
        }
        if (kind === 12) {
          if (!installation || installationOutcome || count !== 21 || installationChecks < 2 || !volume || volume === true) throw refused();
          captureBridge?.assertComplete();
          const outcomeHex = payload.toString("hex"), outcome = readRemoteWorkerRuntimeInstallOutcome(outcomeHex, installation.request, volume);
          if (!outcome.installation || !outcome.outcomeSha256 || (!installation.recovery && !outcome.installation.verified)) throw refused();
          await whileCurrent(assertCurrent, signal); await whileCurrent(installation.authorize, signal);
          const ack = Buffer.alloc(37); ack[0] = 13; ack.writeUInt32LE(32, 1); Buffer.from(outcome.outcomeSha256, "hex").copy(ack, 5);
          await write(ack); installationOutcome = Object.freeze({ outcomeHex, outcome }); return;
        }
        if (kind === 14) {
          if (!poolCapture || !volume || volume === true || count !== 21 || volumeChecks < 2 || authorizedVolumeCount !== count) throw refused();
          poolResponseHex = payload.toString("hex"); return;
        }
        if (kind === 10) {
          if (!installation || count !== 21 || payload.readUInt32LE(96) !== installationChecks + 1 || installationChecks >= 65536 ||
              payload.subarray(0, 32).toString("hex") !== installation.request.nonce ||
              payload.subarray(32, 64).toString("hex") !== installation.requestSha256 ||
              payload.subarray(64, 96).toString("hex") !== installation.request.checkpointSha256 ||
              workspaceCheckpoints.at(-1)?.recordSha256 !== installation.request.checkpointSha256) throw refused();
          ++installationChecks;
          await whileCurrent(assertCurrent, signal);
          await whileCurrent(installation.authorize, signal);
          const ack = Buffer.alloc(105); ack[0] = 11; ack.writeUInt32LE(100, 1); payload.copy(ack, 5);
          await write(ack);
          return;
        }
        if (kind === 4) {
          if (installation && !combinedInstallation) throw refused();
          const ordinal = payload.readUInt32LE(0), observed = payload.readUInt32LE(4);
          const head = workspaceCheckpoints.at(-1)?.recordSha256 ?? mountCheckpoints.at(-1)?.recordSha256 ?? protectionCheckpoints.at(-1)?.recordSha256 ?? formatCheckpoints.at(-1)?.recordSha256 ??
            volumeCheckpoints.at(-1)?.recordSha256 ?? checkpoints.at(-1)?.recordSha256;
          if ((!protectedExchange && volume !== true) || !authorizeVolume || ordinal !== volumeChecks + 1 || ordinal > 256 || observed !== count || (protectedExchange && count !== 21) ||
              count < 5 || count > maximum || payload.subarray(8).toString("hex") !== head) throw refused();
          ++volumeChecks;
          await whileCurrent(assertCurrent, signal);
          await whileCurrent(authorizeVolume, signal);
          const ack = Buffer.alloc(45); ack[0] = 5; ack.writeUInt32LE(40, 1); payload.copy(ack, 5);
          await write(ack);
          authorizedVolumeCount = count;
          return;
        }
        if (kind === 6) {
          if (!capacity || !volume || volume === true || count !== 21 || !volumeChecks || authorizedVolumeCount !== count) throw refused();
          observation = decodeWindowsWorkerCellCapacity(payload, volume);
          return;
        }
        if (kind === 7) {
          if (!backingCapacity || !volume || volume === true || count !== 21 || !volumeChecks || authorizedVolumeCount !== count) throw refused();
          backingObservation = decodeWindowsWorkerCellBackingCapacity(payload, volume);
          return;
        }
        if (kind === 8) {
          if (!inventory || !volume || volume === true || count !== 21 || !volumeChecks || authorizedVolumeCount !== count) throw refused();
          inventorySummary = decodeWindowsWorkerCellCapacity(payload, volume); inventoryBytes = Buffer.from(payload);
          return;
        }
        if (kind === 9) {
          if (!inventory || !inventorySummary) throw refused();
          const start = inventoryChunks.length * 20, totalEntries = inventorySummary.fileCount + inventorySummary.directoryCount;
          if (start >= totalEntries || payload.readUInt32LE(32) !== start || payload.readUInt32LE(36) !== Math.min(20, totalEntries - start) ||
              payload.subarray(0, 32).toString("hex") !== inventorySummary.connectionNonceHex) throw refused();
          inventoryChunks.push(Buffer.from(payload)); return;
        }
        let checkpoint: RemoteWorkerCellProvisioningCheckpoint | RemoteWorkerCellVolumeCheckpoint | RemoteWorkerCellFormatCheckpoint | RemoteWorkerCellProtectionCheckpoint | RemoteWorkerCellMountCheckpoint | RemoteWorkerCellMountedWorkspaceCheckpoint;
        if (checkpoints.length < 5) {
          checkpoint = readRemoteWorkerCellProvisioningCheckpoint(payload.toString("hex"));
          assertRemoteWorkerCellProvisioningSuccessor(plan, checkpoints.at(-1), checkpoint);
          if (mount && volume && volume !== true && checkpoint.recordHex !== volume.records[checkpoints.length]) throw refused();
          checkpoints.push(checkpoint);
        } else if (volumeCheckpoints.length < 6) {
          if (!volume) throw refused();
          if (volume === true && authorizedVolumeCount !== count) throw refused();
          const anchor = deriveRemoteWorkerCellVolumeAnchor(plan, checkpoints.map((record) => record.recordHex));
          checkpoint = readRemoteWorkerCellVolumeCheckpoint(anchor, payload.toString("hex"));
          assertRemoteWorkerCellVolumeSuccessor(anchor, volumeCheckpoints.at(-1), checkpoint);
          if (volume !== true && checkpoint.recordHex !== volume.volumeRecords?.[volumeCheckpoints.length]) throw refused();
          volumeCheckpoints.push(checkpoint);
        } else if (formatCheckpoints.length < 2) {
          if (!format || !volume || (volume === true && authorizedVolumeCount !== count)) throw refused();
          const anchor = { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
            volumeAnchor: deriveRemoteWorkerCellVolumeAnchor(plan, checkpoints.map((record) => record.recordHex)),
            volumeRecords: volumeCheckpoints.map((record) => record.recordHex) };
          checkpoint = readRemoteWorkerCellFormatCheckpoint(anchor, payload.toString("hex"));
          assertRemoteWorkerCellFormatSuccessor(anchor, formatCheckpoints.at(-1), checkpoint);
          if (volume !== true && checkpoint.recordHex !== volume.formatRecords?.[formatCheckpoints.length]) throw refused();
          formatCheckpoints.push(checkpoint);
        } else if (protectionCheckpoints.length < 2) {
          if (!protection || !volume || (volume === true && authorizedVolumeCount !== count)) throw refused();
          const anchor = { schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
            formatAnchor: { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
              volumeAnchor: deriveRemoteWorkerCellVolumeAnchor(plan, checkpoints.map((record) => record.recordHex)),
              volumeRecords: volumeCheckpoints.map((record) => record.recordHex) },
            formatRecords: formatCheckpoints.map((record) => record.recordHex), ownerSid: plan.ownerSid, controllerSid: plan.controllerSid };
          checkpoint = readRemoteWorkerCellProtectionCheckpoint(anchor, payload.toString("hex"));
          assertRemoteWorkerCellProtectionSuccessor(anchor, protectionCheckpoints.at(-1), checkpoint);
          if (volume !== true && checkpoint.recordHex !== volume.protectionRecords?.[protectionCheckpoints.length]) throw refused();
          protectionCheckpoints.push(checkpoint);
        } else if (mountCheckpoints.length < 4) {
          if (!mount || !volume || (volume === true && authorizedVolumeCount !== count)) throw refused();
          const anchor = { schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
            protectionAnchor: { schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
              formatAnchor: { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
                volumeAnchor: deriveRemoteWorkerCellVolumeAnchor(plan, checkpoints.map((record) => record.recordHex)),
                volumeRecords: volumeCheckpoints.map((record) => record.recordHex) },
              formatRecords: formatCheckpoints.map((record) => record.recordHex), ownerSid: plan.ownerSid, controllerSid: plan.controllerSid },
            protectionRecords: protectionCheckpoints.map((record) => record.recordHex), parentIdentityHex: plan.parentIdentityHex,
            workspaceIdentityHex: checkpoints[4]!.workspaceIdentityHex };
          checkpoint = readRemoteWorkerCellMountCheckpoint(anchor, payload.toString("hex"));
          assertRemoteWorkerCellMountSuccessor(anchor, mountCheckpoints.at(-1), checkpoint);
          if (volume !== true && checkpoint.recordHex !== volume.mountRecords?.[mountCheckpoints.length]) throw refused();
          mountCheckpoints.push(checkpoint);
        } else {
          if (!mountedWorkspace || !volume || workspaceCheckpoints.length >= 2 || (volume === true && authorizedVolumeCount !== count)) throw refused();
          const anchor = { schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
            mountAnchor: mountCheckpoints[3]!.anchor, mountRecords: mountCheckpoints.map((record) => record.recordHex), cellName: plan.cellName };
          checkpoint = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, payload.toString("hex"));
          assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, workspaceCheckpoints.at(-1), checkpoint);
          if (volume !== true && checkpoint.recordHex !== volume.mountedWorkspaceRecords?.[workspaceCheckpoints.length]) throw refused();
          workspaceCheckpoints.push(checkpoint);
        }
        if (commit) {
          await whileCurrent(assertCurrent, signal);
          const digest = await whileCurrent(() => commit(checkpoint.recordHex), signal);
          if (digest !== checkpoint.recordSha256) throw refused();
          const ack = Buffer.alloc(41);
          ack[0] = 3; ack.writeUInt32LE(36, 1); ack.writeUInt32LE(count + 1, 5);
          Buffer.from(digest, "hex").copy(ack, 9);
          await write(ack, !volume && checkpoint.sequence === 5);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (failed) return;
        if (total > maximumOutputBytes) { stop(); return; }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
          const kind = pending[0]!, size = pending.readUInt32LE(1);
          if (!((kind === 1 && size === 1024) || (kind === 2 && size === 16) || (installation && kind === 12 && size === 352) || (installation && kind === 10 && size === 100) || ((volume === true || protectedExchange) && kind === 4 && size === 40) ||
              (capacity && kind === 6 && size === 352) || (backingCapacity && kind === 7 && size === 424) ||
              (inventory && ((kind === 8 && size === 352) || (kind === 9 && size === 1000))) ||
              (poolCapture && !combinedInstallation && kind === 14 && size >= 1312 && size <= REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES) ||
              (captureBridge && ((kind === 21 && size === 460) || (kind === 15 && size === 32) || ((kind === 16 || kind === 18) && size === 144) ||
                (kind === 17 && size >= 1312 && size <= REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES))))) { stop(); return; }
          if (pending.length < size + 5) return;
          const payload = Buffer.from(pending.subarray(5, size + 5));
          pending = pending.subarray(size + 5);
          if (kind === 21) {
            try { if (receipt || !attestationRelay) throw refused(); attestationRelay.accept(payload); }
            catch { stop(); return; }
            continue;
          }
          processing = processing.then(() => frame(kind, payload)).catch(stop);
        }
      });
      try {
        if (signal.aborted) stop();
        try { await write(bytes, !commit && !protectedExchange).catch(stop); } finally { if (runtime) bytes.fill(0); }
        const cleanExit = await closed;
        await processing;
        if (!cleanExit || failed || signal.aborted || pending.length || !receipt || receipt.readUInt32LE(0) !== 0 ||
            receipt.readUInt32LE(4) !== checkpoints.length || receipt.readUInt32LE(8) !== (commit ? 1 : 0) ||
            receipt.readUInt32LE(12) !== checkpoints.length + volumeCheckpoints.length + formatCheckpoints.length + protectionCheckpoints.length + mountCheckpoints.length + workspaceCheckpoints.length || ![1, 3, 5].includes(checkpoints.length) ||
            (commit && checkpoints.length !== 5) || (volume && (checkpoints.length !== 5 || volumeCheckpoints.length !== 6)) ||
            (format && formatCheckpoints.length !== 2) || (protection && protectionCheckpoints.length !== 2) || (mount && mountCheckpoints.length !== 4) ||
            (mountedWorkspace && workspaceCheckpoints.length !== 2) || (capacity && !observation) || (backingCapacity && !backingObservation) || (inventory && !objectObservation) || (poolCapture && !combinedInstallation && !poolResponseHex)) throw refused();
        const runtimeReceipt = runtimeParent ? await whileCurrent(() => runtimeParent!.completion, signal) : undefined;
        if (runtimeParent && !runtimeParent.state.finished) throw refused();
        if (protectedExchange) await whileCurrent(installation ? installation.authorize : authorizeVolume!, signal);
        await whileCurrent(assertCurrent, signal);
        const poolDelivery = poolCapture && poolResponseHex ? captureRemoteWorkerNativePoolCapacityResponse(poolResponseHex,
          poolCapture.pool, poolCapture.layout, poolCapture.captureNonce, JSON.parse(poolCapture.referencesJson) as unknown) : undefined;
        if (poolDelivery) { await whileCurrent(authorizeVolume!, signal); await whileCurrent(assertCurrent, signal); }
        if (runtime?.owner.fileStaging) {
          if (!runtimeParent || !runtime.owner.consumeFiles) throw refused();
          const files = runtimeParent.takeFiles();
          try {
            await whileCurrent(() => runtime.owner.consumeFiles!(files, signal), signal);
            await whileCurrent(authorizeVolume!, signal); await whileCurrent(assertCurrent, signal);
          } finally { for (const file of files) file.record.fill(0); }
        }
        runtimeCleanupVerified = runtimeParent?.state.cleanupVerified === true;
        return Object.freeze({ records: Object.freeze(checkpoints.map((checkpoint) => checkpoint.recordHex)),
          volumeRecords: Object.freeze(volumeCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          formatRecords: Object.freeze(formatCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          protectionRecords: Object.freeze(protectionCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          mountRecords: Object.freeze(mountCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          mountedWorkspaceRecords: Object.freeze(workspaceCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          ...(observation ? { capacity: Object.freeze({ ...observation, nativeReceiptHex: receipt.toString("hex") }) } : {}),
          ...(backingObservation ? { backingCapacity: Object.freeze({ ...backingObservation, nativeReceiptHex: receipt.toString("hex") }) } : {}),
          ...(objectObservation ? { inventory: Object.freeze({ ...objectObservation, nativeReceiptHex: receipt.toString("hex") }) } : {}),
          ...(poolDelivery ? { poolCapacity: Object.freeze({ delivery: poolDelivery, nativeReceiptHex: receipt.toString("hex") }) } : {}),
          ...(runtimeReceipt ? { runtime: runtimeReceipt } : {}),
          ...(installation && installationOutcome ? { installation: Object.freeze({ requestSha256: installation.requestSha256, nativeReceiptHex: receipt.toString("hex"), ...installationOutcome }) } : {}) });
      } finally {
        signal.removeEventListener("abort", stop);
        // Even failed input/transport setup must join only the child we launched.
        if (child.exitCode === null && child.signalCode === null) stop();
        await closed;
      }
    } finally {
      captureBridge?.close();
      attestationRelay?.close();
      if (runtime) bytes.fill(0);
      let parentClosed = false;
      try { await runtimeParent?.close(); parentClosed = true; }
      finally {
        // Retained cleanup evidence is usable only after the exact helper and
        // both parent endpoints have joined. Uncertainty remains sticky.
        finishRuntimeWriter?.(parentClosed && (!runtimeLaunched || runtimeCleanupVerified));
        leases.delete(pinned.lease);
      }
    }
  };
  const installationExchange = async (input: RemoteWorkerCellProvisioningExchange, supplied: RemoteWorkerRuntimeInstallRequest,
      expected: { readonly nonce: string; readonly requestSha256: string }, authorize: (request: RemoteWorkerRuntimeInstallRequest) => Promise<void>, recovery: boolean,
      beforeFinish?: WindowsWorkerInstallationFinish, poolCapture?: WindowsWorkerPoolCapacityRequest,
      captureAdmission?: WindowsWorkerInstallationCaptureAdmission) => {
      if (typeof authorize !== "function" || (!recovery && typeof beforeFinish !== "function")) throw refused();
      if (Boolean(poolCapture) !== Boolean(captureAdmission) || (recovery && poolCapture)) throw refused();
      if (captureAdmission && typeof captureAdmission.finish !== "function") throw refused();
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const encoded = encodeRemoteWorkerRuntimeInstallRequest(supplied);
      const admitted = decodeRemoteWorkerRuntimeInstallRequest(encoded, expected);
      const first = readRemoteWorkerCellProvisioningCheckpoint(canonical.records[0]!);
      if (admitted.journalIdentityHex !== first.journalIdentityHex || admitted.preparedSha256 !== first.recordSha256 ||
          admitted.checkpointSha256 !== canonical.mountedWorkspaceRecords?.at(-1)?.slice(-64)) throw refused();
      const pool = poolCapture ? Object.freeze({ pool: normalizeRemoteWorkerNativePoolSnapshot(poolCapture.pool),
        layout: normalizeRemoteWorkerNativeCapacityLayout(poolCapture.layout), captureNonce: poolCapture.captureNonce,
        referencesJson: poolCapture.referencesJson }) : undefined;
      if (pool && (pool.layout.assignmentBindingSha256 !== canonical.plan.assignmentBindingSha256 ||
          pool.layout.profileSha256 !== canonical.plan.profileSha256 || pool.layout.rootIdentityHex[0] !== canonical.plan.parentIdentityHex)) throw refused();
      const admission = captureAdmission ? Object.freeze({ ...captureAdmission }) : undefined;
      const terminalStop = new AbortController();
      const activitySignal = AbortSignal.any([callerSignal, terminalStop.signal, AbortSignal.timeout(wallMs)]);
      let resolveJoined!: () => void, rejectJoined!: (error: unknown) => void;
      const joined = new Promise<void>((resolve, reject) => { resolveJoined = resolve; rejectJoined = reject; });
      void joined.catch(() => undefined);
      let terminal: Promise<void> | undefined, joinCalled = false, callComplete = false, terminalComplete = false, open = true;
      const captured = Object.freeze({ request: admitted, bytes: encoded, requestSha256: expected.requestSha256, authorize: () => authorize(admitted),
        recovery, captureAdmission: admission,
        beforeFinish: admission ? async (receipt: Parameters<WindowsWorkerInstallationFinish>[0], signal: AbortSignal) => {
          await beforeFinish!(receipt, signal);
          signal.throwIfAborted();
          if (terminal) throw refused();
          let permit!: () => void, rejectPermit!: (error: unknown) => void;
          const permitted = new Promise<void>((resolve, reject) => { permit = resolve; rejectPermit = reject; });
          terminal = Promise.resolve().then(() => admission.finish(async () => {
            signal.throwIfAborted();
            if (!open || joinCalled) { terminalStop.abort(); throw refused(); }
            joinCalled = true; permit();
            await joined;
          }, signal)).then(() => {
            if (!joinCalled || !callComplete) throw refused();
            terminalComplete = true;
          });
          void terminal.catch(error => { rejectPermit(error); terminalStop.abort(error); });
          // Gateway verification invokes join to release this barrier. The
          // protocol can now send EOF, but reservation release still awaits the
          // complete helper call below, including its shutdown and final checks.
          await whileCurrent(() => permitted, signal);
        } : beforeFinish });
      const result = await workerLocalStateActivity.quiescent(async () => {
        try {
          const result = await call(canonical.plan, canonical.records[0], undefined, canonical, pool ? captured.authorize : undefined,
            true, true, true, true, false, false, false, undefined, captured, activitySignal, pool);
          callComplete = true; resolveJoined();
          if (terminal) await whileCurrent(() => terminal!, activitySignal);
          if (admission && !terminalComplete) throw refused();
          return result;
        } catch (error) {
          rejectJoined(error); terminalStop.abort(error); throw error;
        } finally { open = false; }
      }, activitySignal);
      if (!result.installation) throw refused(); return result.installation;
  };
  return Object.freeze({
    installRuntimeWithCapacity: async (input: RemoteWorkerCellProvisioningExchange, supplied: RemoteWorkerRuntimeInstallRequest,
      expected: { readonly nonce: string; readonly requestSha256: string }, authorize: (request: RemoteWorkerRuntimeInstallRequest) => Promise<void>,
      beforeFinish: WindowsWorkerInstallationFinish, capture: WindowsWorkerPoolCapacityRequest, admission: WindowsWorkerInstallationCaptureAdmission) => {
      if (!capture || !admission) throw refused();
      return installationExchange(input, supplied, expected, authorize, false, beforeFinish, capture, admission);
    },
    installRuntime: (input: RemoteWorkerCellProvisioningExchange, supplied: RemoteWorkerRuntimeInstallRequest,
      expected: { readonly nonce: string; readonly requestSha256: string }, authorize: (request: RemoteWorkerRuntimeInstallRequest) => Promise<void>,
      beforeFinish: WindowsWorkerInstallationFinish) =>
      installationExchange(input, supplied, expected, authorize, false, beforeFinish),
    recoverRuntimeInstallation: (input: RemoteWorkerCellProvisioningExchange, supplied: RemoteWorkerRuntimeInstallRequest,
      expected: { readonly nonce: string; readonly requestSha256: string }, authorizeRead: (request: RemoteWorkerRuntimeInstallRequest) => Promise<void>) =>
      installationExchange(input, supplied, expected, authorizeRead, true),
    runRuntime: async (input: RemoteWorkerCellProvisioningExchange, request: WindowsWorkerCellRuntimeRequest,
      authorize: () => Promise<void>): Promise<RemoteWorkerRuntimeResultReceipt> => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const expected = normalizeRemoteWorkerRuntimeResultExpectation(request.expected);
      const admitted = normalizeWindowsRuntimeDispatch(request.request);
      const prepared = prepareWindowsRuntimeDispatch(admitted);
      if (canonicalJsonString(prepared.expectation) !== canonicalJsonString(expected)) throw refused();
      if (admitted.fileStaging && (typeof request.owner.authorizeFile !== "function" || typeof request.owner.consumeFiles !== "function")) throw refused();
      const captured = Object.freeze({ expected, bytes: prepared.bytes, owner: Object.freeze({ ...request.owner, fileStaging: admitted.fileStaging }) });
      const result = await call(canonical.plan, canonical.records[0], undefined, canonical, authorize,
        true, true, true, true, false, false, false, captured);
      if (!result.runtime) throw refused(); return result.runtime;
    },
    create: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>): Promise<void> => {
      if (typeof commit !== "function") throw refused();
      await call(plan, undefined, commit);
    },
    recover: async (input: RemoteWorkerCellProvisioningRecovery): Promise<readonly string[]> => (await call(input.plan, input.preparedRecordHex)).records,
    createVolume: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>,
      authorizeVolume: () => Promise<void>): Promise<void> => {
      if (typeof commit !== "function" || typeof authorizeVolume !== "function") throw refused();
      await call(plan, undefined, commit, true, authorizeVolume);
    },
    recoverVolume: async (input: RemoteWorkerCellProvisioningExchange) => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const result = await call(canonical.plan, canonical.records[0], undefined, canonical);
      return Object.freeze({ records: result.records, volumeRecords: result.volumeRecords });
    },
    createFormat: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>,
      authorize: () => Promise<void>): Promise<void> => {
      if (typeof commit !== "function" || typeof authorize !== "function") throw refused();
      await call(plan, undefined, commit, true, authorize, true);
    },
    recoverFormat: async (input: RemoteWorkerCellProvisioningExchange) => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const result = await call(canonical.plan, canonical.records[0], undefined, canonical, undefined, true);
      return Object.freeze({ records: result.records, volumeRecords: result.volumeRecords, formatRecords: result.formatRecords });
    },
    createProtection: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>,
      authorize: () => Promise<void>): Promise<void> => {
      if (typeof commit !== "function" || typeof authorize !== "function") throw refused();
      await call(plan, undefined, commit, true, authorize, true, true);
    },
    recoverProtection: async (input: RemoteWorkerCellProvisioningExchange) => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const result = await call(canonical.plan, canonical.records[0], undefined, canonical, undefined, true, true);
      return Object.freeze({ records: result.records, volumeRecords: result.volumeRecords, formatRecords: result.formatRecords,
        protectionRecords: result.protectionRecords });
    },
    createMount: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>,
      authorize: () => Promise<void>): Promise<void> => {
      if (typeof commit !== "function" || typeof authorize !== "function") throw refused();
      await call(plan, undefined, commit, true, authorize, true, true, true);
    },
    recoverMount: async (input: RemoteWorkerCellProvisioningExchange) => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const result = await call(canonical.plan, canonical.records[0], undefined, canonical, undefined, true, true, true);
      return Object.freeze({ records: result.records, volumeRecords: result.volumeRecords, formatRecords: result.formatRecords,
        protectionRecords: result.protectionRecords, mountRecords: result.mountRecords });
    },
    createMountedWorkspace: async (plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>,
      authorize: () => Promise<void>): Promise<void> => {
      if (typeof commit !== "function" || typeof authorize !== "function") throw refused();
      await call(plan, undefined, commit, true, authorize, true, true, true, true);
    },
    recoverMountedWorkspace: async (input: RemoteWorkerCellProvisioningExchange) => {
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      return call(canonical.plan, canonical.records[0], undefined, canonical, undefined, true, true, true, true);
    },
    observeCapacity: async (input: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>): Promise<WindowsWorkerCellCapacityResult> => {
      if (typeof authorize !== "function") throw refused();
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const observationSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(wallMs)]);
      const result = await workerLocalStateActivity.quiescent(() => call(canonical.plan, canonical.records[0], undefined, canonical, authorize,
        true, true, true, true, true, false, false, undefined, undefined, observationSignal), observationSignal);
      if (!result.capacity) throw refused();
      return result.capacity;
    },
    observeBackingCapacity: async (input: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>): Promise<WindowsWorkerCellBackingCapacityResult> => {
      if (typeof authorize !== "function") throw refused();
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const observationSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(wallMs)]);
      const result = await workerLocalStateActivity.quiescent(() => call(canonical.plan, canonical.records[0], undefined, canonical, authorize,
        true, true, true, true, false, true, false, undefined, undefined, observationSignal), observationSignal);
      if (!result.backingCapacity) throw refused();
      return result.backingCapacity;
    },
    observePoolCapacity: async (input: RemoteWorkerCellProvisioningExchange, supplied: WindowsWorkerPoolCapacityRequest, authorize: () => Promise<void>) => {
      if (typeof authorize !== "function") throw refused();
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const pool = normalizeRemoteWorkerNativePoolSnapshot(supplied.pool), layout = normalizeRemoteWorkerNativeCapacityLayout(supplied.layout);
      const captureNonce = supplied.captureNonce, referencesJson = supplied.referencesJson;
      if (typeof captureNonce !== "string" || !/^[0-9a-f]{64}$/u.test(captureNonce) || /^0+$/u.test(captureNonce) ||
          typeof referencesJson !== "string" || Buffer.byteLength(referencesJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES ||
          layout.assignmentBindingSha256 !== canonical.plan.assignmentBindingSha256 || layout.profileSha256 !== canonical.plan.profileSha256 ||
          layout.rootIdentityHex[0] !== canonical.plan.parentIdentityHex) throw refused();
      const references = JSON.parse(referencesJson) as unknown;
      if (!Array.isArray(references) || references.length > 20000) throw refused();
      const referenceIds = new Set<string>();
      for (const item of references) {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 2 ||
            ![item.referenceSha256, item.objectIdentitySha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0+$/u.test(value)) ||
            referenceIds.has(item.referenceSha256)) throw refused();
        referenceIds.add(item.referenceSha256);
      }
      const capture = Object.freeze({ pool, layout, captureNonce, referencesJson: canonicalJsonString(references) });
      const deadline = performance.now() + wallMs;
      const observationSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(wallMs)]);
      const result = await workerLocalStateActivity.quiescent(() => call(canonical.plan, canonical.records[0], undefined, canonical, authorize,
        true, true, true, true, false, false, false, undefined, undefined, observationSignal, capture), observationSignal);
      if (!result.poolCapacity || performance.now() >= deadline) throw refused();
      return result.poolCapacity;
    },
    observeInventory: async (input: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>): Promise<WindowsWorkerCellObjectInventoryResult> => {
      if (typeof authorize !== "function") throw refused();
      const canonical = normalizeRemoteWorkerCellProvisioningExchange(input);
      const observationSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(wallMs)]);
      const result = await workerLocalStateActivity.quiescent(() => call(canonical.plan, canonical.records[0], undefined, canonical, authorize,
        true, true, true, true, false, false, true, undefined, undefined, observationSignal), observationSignal);
      if (!result.inventory) throw refused();
      return result.inventory;
    },
  });
}
