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
} from "@goatcitadel/contracts";

/** Trusted composition only. Registry/model data cannot select an executable or
 * provide parent custody. The native owner rechecks the actual protected parent. */
export interface WindowsWorkerCellProvisioningImageGuard {
  pinCellProvisioningExecutor(): { readonly executorPath: string; readonly lease: object };
}
export interface WindowsWorkerCellProvisioningOptions {
  readonly parentPath: string;
  readonly wallMs: number;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  /** Trusted installed-service composition only; this never falls back to the
   * direct component path when controller admission or transport fails. */
  readonly controllerService?: boolean;
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
}
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
  volume?: true | RemoteWorkerCellProvisioningExchange, format = false, protection = false, mount = false, mountedWorkspace = false,
): Buffer {
  const plan = normalizeRemoteWorkerCellProvisioningPlan(input);
  if (typeof format !== "boolean" || typeof protection !== "boolean" || typeof mount !== "boolean" || typeof mountedWorkspace !== "boolean" ||
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
      !Number.isSafeInteger(wallMs) || wallMs < 100 || wallMs > 600000) throw refused();
  const parent = Buffer.from(parentPath, "utf8");
  if (!parent.length || parent.length > 8192 || parent.toString("utf8") !== parentPath) throw refused();
  const header = Buffer.alloc(20), bytes = Buffer.alloc(528);
  header.write("GCPROV01", 0, "ascii"); header.writeUInt32LE((preparedRecordHex === undefined ? 1 : 2) + (mountedWorkspace ? 10 : mount ? 8 : protection ? 6 : format ? 4 : volume ? 2 : 0), 8);
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
  const { parentPath, wallMs, signal: callerSignal, assertCurrent, imageGuard, controllerService } = options;
  if (controllerService !== undefined && typeof controllerService !== "boolean") throw refused();
  const call = async (input: RemoteWorkerCellProvisioningPlan, preparedRecordHex: string | undefined,
    commit?: (recordHex: string) => Promise<string>, volume?: true | RemoteWorkerCellProvisioningExchange,
    authorizeVolume?: () => Promise<void>, format = false, protection = false, mount = false, mountedWorkspace = false): Promise<{
      readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
      readonly protectionRecords: readonly string[]; readonly mountRecords: readonly string[]; readonly mountedWorkspaceRecords: readonly string[];
    }> => {
    const plan = normalizeRemoteWorkerCellProvisioningPlan(input);
    if (volume !== undefined && (!controllerService || (volume === true && (!commit || !authorizeVolume)))) throw refused();
    const bytes = encodeWindowsWorkerCellProvisioning(plan, parentPath, wallMs, preparedRecordHex, volume, format, protection, mount, mountedWorkspace);
    const maximum = mountedWorkspace ? 21 : mount ? 19 : protection ? 15 : format ? 13 : volume ? 11 : 5;
    // Twenty-one checkpoints, at most 256 authority challenges, and one receipt.
    // Keep the existing limits for earlier protocol operations.
    const maximumOutputBytes = mountedWorkspace ? 21 * 1029 + 256 * 45 + 21 : volume ? 32768 : 8192;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([callerSignal, cancellation.signal, AbortSignal.timeout(wallMs)]);
    signal.throwIfAborted();
    if (process.platform !== "win32") throw refused();
    await whileCurrent(assertCurrent, signal);
    const pinned = pinProvisioningHelper(imageGuard);
    leases.add(pinned.lease);
    try {
      signal.throwIfAborted();
      const child = spawn(pinned.executorPath, controllerService ? ["--controller"] : [], { cwd: path.dirname(pinned.executorPath), windowsHide: true,
        shell: false, env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"] });
      let failed = false, total = 0, pending = Buffer.alloc(0), receipt: Buffer | undefined;
      let processing = Promise.resolve();
      const checkpoints: RemoteWorkerCellProvisioningCheckpoint[] = [];
      const volumeCheckpoints: RemoteWorkerCellVolumeCheckpoint[] = [];
      const formatCheckpoints: RemoteWorkerCellFormatCheckpoint[] = [];
      const protectionCheckpoints: RemoteWorkerCellProtectionCheckpoint[] = [];
      const mountCheckpoints: RemoteWorkerCellMountCheckpoint[] = [];
      const workspaceCheckpoints: RemoteWorkerCellMountedWorkspaceCheckpoint[] = [];
      let volumeChecks = 0, authorizedVolumeCount = 0;
      const stop = () => {
        if (failed) return;
        failed = true; cancellation.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        child.stdin.destroy();
      };
      const closed = new Promise<boolean>((resolve) => child.once("close", (code, exitSignal) => resolve(code === 0 && !exitSignal)));
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", stop); child.stdin.on("error", stop); child.stdout.on("error", stop);
      child.stderr.on("error", stop); child.stderr.on("data", stop);
      const write = (value: Buffer, last = false) => new Promise<void>((resolve, reject) => {
        if (failed || signal.aborted) { reject(refused()); return; }
        const done = (error?: Error | null) => error ? reject(refused()) : resolve();
        if (last) child.stdin.end(value, done); else child.stdin.write(value, done);
      });
      const frame = async (kind: number, payload: Buffer) => {
        if (failed || receipt) throw refused();
        const count = checkpoints.length + volumeCheckpoints.length + formatCheckpoints.length + protectionCheckpoints.length + mountCheckpoints.length + workspaceCheckpoints.length;
        if (kind === 2) {
          if (volume === true && payload.readUInt32LE(0) === 0 && (count !== maximum || authorizedVolumeCount !== count)) throw refused();
          receipt = payload;
          if (volume === true) await write(Buffer.alloc(0), true);
          return;
        }
        if (kind === 4) {
          const ordinal = payload.readUInt32LE(0), observed = payload.readUInt32LE(4);
          const head = workspaceCheckpoints.at(-1)?.recordSha256 ?? mountCheckpoints.at(-1)?.recordSha256 ?? protectionCheckpoints.at(-1)?.recordSha256 ?? formatCheckpoints.at(-1)?.recordSha256 ??
            volumeCheckpoints.at(-1)?.recordSha256 ?? checkpoints.at(-1)?.recordSha256;
          if (volume !== true || !authorizeVolume || ordinal !== volumeChecks + 1 || ordinal > 256 || observed !== count ||
              count < 5 || count > maximum || payload.subarray(8).toString("hex") !== head) throw refused();
          ++volumeChecks;
          await whileCurrent(assertCurrent, signal);
          await whileCurrent(authorizeVolume, signal);
          const ack = Buffer.alloc(45); ack[0] = 5; ack.writeUInt32LE(40, 1); payload.copy(ack, 5);
          await write(ack);
          authorizedVolumeCount = count;
          return;
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
          if (!((kind === 1 && size === 1024) || (kind === 2 && size === 16) || (volume === true && kind === 4 && size === 40))) { stop(); return; }
          if (pending.length < size + 5) return;
          const payload = Buffer.from(pending.subarray(5, size + 5));
          pending = pending.subarray(size + 5);
          processing = processing.then(() => frame(kind, payload)).catch(stop);
        }
      });
      try {
        if (signal.aborted) stop();
        await write(bytes, !commit).catch(stop);
        const cleanExit = await closed;
        await processing;
        if (!cleanExit || failed || signal.aborted || pending.length || !receipt || receipt.readUInt32LE(0) !== 0 ||
            receipt.readUInt32LE(4) !== checkpoints.length || receipt.readUInt32LE(8) !== (commit ? 1 : 0) ||
            receipt.readUInt32LE(12) !== checkpoints.length + volumeCheckpoints.length + formatCheckpoints.length + protectionCheckpoints.length + mountCheckpoints.length + workspaceCheckpoints.length || ![1, 3, 5].includes(checkpoints.length) ||
            (commit && checkpoints.length !== 5) || (volume && (checkpoints.length !== 5 || volumeCheckpoints.length !== 6)) ||
            (format && formatCheckpoints.length !== 2) || (protection && protectionCheckpoints.length !== 2) || (mount && mountCheckpoints.length !== 4) ||
            (mountedWorkspace && workspaceCheckpoints.length !== 2)) throw refused();
        await whileCurrent(assertCurrent, signal);
        return Object.freeze({ records: Object.freeze(checkpoints.map((checkpoint) => checkpoint.recordHex)),
          volumeRecords: Object.freeze(volumeCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          formatRecords: Object.freeze(formatCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          protectionRecords: Object.freeze(protectionCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          mountRecords: Object.freeze(mountCheckpoints.map((checkpoint) => checkpoint.recordHex)),
          mountedWorkspaceRecords: Object.freeze(workspaceCheckpoints.map((checkpoint) => checkpoint.recordHex)) });
      } finally {
        signal.removeEventListener("abort", stop);
        // Even failed input/transport setup must join only the child we launched.
        if (child.exitCode === null && child.signalCode === null) stop();
        await closed;
      }
    } finally { leases.delete(pinned.lease); }
  };
  return Object.freeze({
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
  });
}
