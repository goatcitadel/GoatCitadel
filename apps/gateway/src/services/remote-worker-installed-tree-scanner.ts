/* eslint-disable max-lines -- Cross-platform retained-handle scanning, policy, hashing, and deadlines stay co-located for auditability. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix as posixPath, win32 as windowsPath } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonString } from "@goatcitadel/contracts";
import {
  REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
  REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION,
  type RemoteWorkerInstalledTreeAttestation,
  type RemoteWorkerInstalledTreeFile,
  type RemoteWorkerInstalledTreeRole,
  type RemoteWorkerInstalledTreeScannerPort,
} from "./remote-worker-attestation-service.js";
import {
  enumerateRemoteWorkerWindowsDirectory,
  hashRemoteWorkerWindowsFile,
  readRemoteWorkerWindowsFile,
  type RemoteWorkerWindowsDirectoryEvidence,
  type RemoteWorkerWindowsFileObservation,
} from "./remote-worker-windows-no-follow.js";

const REQUIRED_ROOT_DIRECTORIES = ["bundle", "launcher", "locks", "runtime", "vendor"] as const;
const SINGLETON_DIRECTORIES = new Map<string, RemoteWorkerInstalledTreeRole>([
  ["bundle", "bundle"],
  ["launcher", "launcher"],
  ["locks", "dependency_lock"],
]);
const RECURSIVE_DIRECTORIES = new Map<string, RemoteWorkerInstalledTreeRole>([
  ["runtime", "runtime"],
  ["vendor", "vendor"],
]);
const WINDOWS_REPARSE_ATTRIBUTE = 0x400;
const WINDOWS_DIRECTORY_ATTRIBUTE = 0x10;
const WINDOWS_DEVICE_ATTRIBUTE = 0x40;
const POSIX_READ_BUFFER_BYTES = 64 * 1024;
const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const FIXED_SCAN_DEADLINE_MS = 120_000;
const MINIMUM_WINDOWS_HELPER_DEADLINE_MS = 100;
const POSIX_HELPER_SCHEMA_VERSION = "goatcitadel.remote-worker-posix-tree-scan.v1" as const;
const POSIX_HELPER_ENTRYPOINT_FLAG = "--goatcitadel-posix-tree-scan-helper-v1";
const POSIX_HELPER_MAX_REQUEST_BYTES = 16 * 1024;
const POSIX_HELPER_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const POSIX_HELPER_FRAME_HEADER_BYTES = 4;
const POSIX_HELPER_TEST_GUARD = "GOATCITADEL_POSIX_SCAN_HELPER_TEST_ONLY";

let posixScanHelperRunning = false;
let posixScanHelperPid: number | undefined;
let posixScanHelperReceivedBytes = 0;

interface ScanLimits {
  readonly maxFileCount: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

interface ScannedTree {
  readonly rootIdentity: string;
  readonly files: readonly RemoteWorkerInstalledTreeFile[];
  readonly totalBytes: number;
}

interface ScanDeadline {
  check(): void;
  remainingWindowsHelperMs(): number;
  remainingProcessHelperMs(): number;
  readonly signal: AbortSignal | undefined;
}

interface PosixScanHelperOptions {
  readonly signal: AbortSignal | undefined;
  readonly onTerminationRequested: (() => void) | undefined;
}

interface PosixScanHelperRequest {
  readonly schemaVersion: typeof POSIX_HELPER_SCHEMA_VERSION;
  readonly operation: "scan" | "probe";
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly root?: string;
  readonly limits?: ScanLimits;
  readonly probeBehavior?: "success" | "hang";
}

interface PosixDirectoryHandle {
  readonly handle: FileHandle;
  readonly absolutePath: string;
  readonly descriptorPath: string;
  readonly initialStat: PosixStatSnapshot;
}

interface PosixStatSnapshot {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly linkCount: string;
  readonly sizeBytes: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
  readonly uid: number;
  readonly kind: "directory" | "regular_file" | "symlink" | "special";
}

export class RemoteWorkerInstalledTreeScannerError extends Error {
  readonly code = "REMOTE_WORKER_INSTALLED_TREE_SCANNER_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerInstalledTreeScannerError";
  }
}

/**
 * Trusted scanner whose construction permanently binds one already-verified manifest payload.
 * Platform helpers provide handle evidence only; this owner assigns every path role and digest.
 */
export class RemoteWorkerInstalledTreeScanner implements RemoteWorkerInstalledTreeScannerPort {
  readonly #runtimeManifestPayloadSha256: string;
  readonly #clock: () => Date;

  constructor(runtimeManifestPayloadSha256: string, clock: () => Date = () => new Date()) {
    this.#runtimeManifestPayloadSha256 = canonicalSha256(runtimeManifestPayloadSha256, "manifest payload digest");
    this.#clock = clock;
  }

  public async scan(input: {
    readonly root: string;
    readonly maxFileCount: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteWorkerInstalledTreeAttestation> {
    const deadline = createScanDeadline(input.deadlineMs, input.signal);
    deadline.check();
    const limits = normalizeLimits(input);
    const root = canonicalRoot(input.root);
    const tree =
      process.platform === "win32"
        ? await scanWindowsTree(root, limits, deadline)
        : await scanPosixTree(root, limits, deadline);
    deadline.check();
    const scannedAt = canonicalClock(this.#clock());
    const files = Object.freeze([...tree.files].sort(compareFilePaths));
    deadline.check();
    const treeSha256 = sha256Utf8(
      canonicalJsonString({
        schemaVersion: REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION,
        rootIdentity: tree.rootIdentity,
        files,
        totalBytes: tree.totalBytes,
      }),
    );
    deadline.check();
    const attestationSha256 = sha256Utf8(
      canonicalJsonString({
        schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
        runtimeManifestPayloadSha256: this.#runtimeManifestPayloadSha256,
        scannedAt,
        rootIdentity: tree.rootIdentity,
        totalBytes: tree.totalBytes,
        treeSha256,
      }),
    );
    deadline.check();
    return Object.freeze({
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
      runtimeManifestPayloadSha256: this.#runtimeManifestPayloadSha256,
      scannedAt,
      rootIdentity: tree.rootIdentity,
      files,
      totalBytes: tree.totalBytes,
      treeSha256,
      attestationSha256,
    });
  }
}

export async function readRemoteWorkerNoFollowFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const maxBytes = boundedPositiveInteger(maximumBytes, MAX_TRUST_FILE_BYTES, "trust file byte limit");
  if (process.platform === "win32") {
    if (
      typeof filePath !== "string" ||
      windowsPath.normalize(filePath) !== filePath ||
      !windowsPath.isAbsolute(filePath)
    ) {
      throw invalid("Remote worker trust file path is invalid.");
    }
    const root = windowsPath.dirname(filePath);
    if (/^[A-Za-z]:\\$/u.test(root)) throw invalid("Remote worker trust file root is unsupported.");
    const evidence = await readRemoteWorkerWindowsFile(root, windowsPath.basename(filePath), maxBytes);
    try {
      const rootOwnerSid = evidence.ancestorsBefore[0]?.ownerSid;
      if (rootOwnerSid === undefined) throw invalid("Remote worker trust file ancestry is unavailable.");
      if (rootOwnerSid !== evidence.operatorSid) throw invalid("Remote worker trust file is not operator-owned.");
      for (const ancestor of evidence.ancestorsBefore) assertSafeWindowsDirectory(ancestor, rootOwnerSid);
      assertSafeWindowsRegularFile(evidence.before, rootOwnerSid);
      assertSameWindowsObservation(evidence.before, evidence.after);
      return Buffer.from(evidence.content);
    } finally {
      evidence.content.fill(0);
    }
  }
  const opened = await openPosixAbsoluteFile(filePath, maxBytes);
  try {
    return Buffer.from(opened.content);
  } finally {
    opened.content.fill(0);
    await closeAll(opened.ancestors);
  }
}

/** Pure policy seam used by deterministic tests; it does not grant filesystem authority. */
export function assertRemoteWorkerWindowsObservationSafe(
  observation: RemoteWorkerWindowsFileObservation,
  expectedOwnerSid?: string,
): void {
  assertSafeWindowsRegularFile(observation, expectedOwnerSid);
}

/** Secret-free process-isolation diagnostics for operator proof and deterministic cleanup tests. */
export function remoteWorkerPosixScanHelperDiagnostics(): Readonly<{
  executableKind: "current_node_module";
  protocolSchemaVersion: typeof POSIX_HELPER_SCHEMA_VERSION;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  completeScanIsolation: true;
  active: boolean;
  activePid: number | undefined;
  receivedResponseBytes: number;
}> {
  return Object.freeze({
    executableKind: "current_node_module",
    protocolSchemaVersion: POSIX_HELPER_SCHEMA_VERSION,
    maximumRequestBytes: POSIX_HELPER_MAX_REQUEST_BYTES,
    maximumResponseBytes: POSIX_HELPER_MAX_RESPONSE_BYTES,
    completeScanIsolation: true,
    active: posixScanHelperRunning,
    activePid: posixScanHelperPid,
    receivedResponseBytes: posixScanHelperReceivedBytes,
  });
}

/** Test-only fixed-helper exercise. It cannot scan a caller-selected path. */
export async function exerciseRemoteWorkerPosixScanHelperForTesting(input: {
  readonly behavior: "success" | "hang";
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onTerminationRequested?: () => void;
}): Promise<void> {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw invalid("Remote worker POSIX scan helper test exercise is unavailable.");
  }
  const deadlineMs = boundedPositiveInteger(input.deadlineMs, FIXED_SCAN_DEADLINE_MS, "scan deadline");
  const requestId = randomBytes(16).toString("hex");
  const response = await invokeFixedPosixScanHelper(
    Object.freeze({
      schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
      operation: "probe",
      requestId,
      deadlineMs,
      probeBehavior: input.behavior,
    }),
    deadlineMs,
    { signal: input.signal, onTerminationRequested: input.onTerminationRequested },
  );
  const record = exactRecord(response, ["schemaVersion", "operation", "requestId", "ok"]);
  if (
    record.schemaVersion !== POSIX_HELPER_SCHEMA_VERSION ||
    record.operation !== "probe" ||
    record.requestId !== requestId ||
    record.ok !== true
  ) {
    throw invalid("Remote worker POSIX scan helper response was invalid.");
  }
}

async function invokeFixedPosixScanHelper(
  request: PosixScanHelperRequest,
  deadlineMs: number,
  options: PosixScanHelperOptions,
): Promise<unknown> {
  if (posixScanHelperRunning) throw invalid("Remote worker POSIX scan helper is already active.");
  if (options.signal?.aborted === true) throw invalid("Remote worker installed-tree scan was aborted.");
  const requestFrame = encodePosixHelperFrame(request, POSIX_HELPER_MAX_REQUEST_BYTES);
  const command = fixedPosixHelperCommand();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, command, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        NODE_ENV: request.operation === "probe" ? "test" : "production",
        [POSIX_HELPER_TEST_GUARD]: request.operation === "probe" ? "1" : "0",
      },
    });
  } catch {
    requestFrame.fill(0);
    throw invalid("Remote worker POSIX scan helper could not start.");
  }
  posixScanHelperRunning = true;
  posixScanHelperPid = child.pid;
  posixScanHelperReceivedBytes = 0;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let acceptingOutput = true;
      let settled = false;
      let pendingError: Error | undefined;

      const discardChunks = (): void => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
      };
      const onStdoutData = (chunk: Buffer): void => {
        if (!acceptingOutput) return;
        received += chunk.byteLength;
        posixScanHelperReceivedBytes = received;
        if (received > POSIX_HELPER_MAX_RESPONSE_BYTES + POSIX_HELPER_FRAME_HEADER_BYTES) {
          stopAndPoison(invalid("Remote worker POSIX scan helper response exceeded its byte limit."));
          return;
        }
        chunks.push(Buffer.from(chunk));
      };
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const stopAndPoison = (error: Error): void => {
        if (settled || pendingError !== undefined) return;
        pendingError = error;
        acceptingOutput = false;
        discardChunks();
        child.stdout?.off("data", onStdoutData);
        try {
          options.onTerminationRequested?.();
        } catch (callbackError) {
          pendingError =
            callbackError instanceof Error ? callbackError : invalid("POSIX scan helper test hook failed.");
        }
        child.kill("SIGKILL");
      };
      const abort = (): void => {
        stopAndPoison(invalid("Remote worker installed-tree scan was aborted."));
      };
      const timer = setTimeout(() => {
        stopAndPoison(invalid("Remote worker installed-tree scan exceeded its deadline."));
      }, deadlineMs);
      timer.unref();

      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        stopAndPoison(invalid("Remote worker POSIX scan helper could not start."));
      });
      child.stdin?.once("error", () => {
        stopAndPoison(invalid("Remote worker POSIX scan helper request could not be delivered."));
      });
      child.stdout?.on("data", onStdoutData);
      child.once("close", (code) => {
        posixScanHelperRunning = false;
        posixScanHelperPid = undefined;
        posixScanHelperReceivedBytes = 0;
        acceptingOutput = false;
        child.stdout?.off("data", onStdoutData);
        if (pendingError !== undefined) {
          finish(pendingError);
          return;
        }
        if (code !== 0) {
          discardChunks();
          finish(invalid("Remote worker POSIX scan helper failed."));
          return;
        }
        const responseFrame = Buffer.concat(chunks, received);
        discardChunks();
        try {
          const decoded = decodePosixHelperFrame(responseFrame, POSIX_HELPER_MAX_RESPONSE_BYTES);
          const responseError = parsePosixScanHelperError(decoded, request.requestId);
          finish(responseError, responseError === undefined ? decoded : undefined);
        } catch {
          finish(invalid("Remote worker POSIX scan helper response was invalid."));
        } finally {
          responseFrame.fill(0);
        }
      });
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      child.stdin?.end(requestFrame);
    });
  } finally {
    requestFrame.fill(0);
  }
}

function fixedPosixHelperCommand(): string[] {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".ts")) {
    const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    return ["--import", loaderUrl, modulePath, POSIX_HELPER_ENTRYPOINT_FLAG];
  }
  return [modulePath, POSIX_HELPER_ENTRYPOINT_FLAG];
}

function encodePosixHelperFrame(value: unknown, maximumPayloadBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  try {
    if (payload.byteLength < 2 || payload.byteLength > maximumPayloadBytes) {
      throw invalid("Remote worker POSIX scan helper frame exceeded its byte limit.");
    }
    const frame = Buffer.allocUnsafe(POSIX_HELPER_FRAME_HEADER_BYTES + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, POSIX_HELPER_FRAME_HEADER_BYTES);
    return frame;
  } finally {
    payload.fill(0);
  }
}

function decodePosixHelperFrame(frame: Buffer, maximumPayloadBytes: number): unknown {
  if (frame.byteLength < POSIX_HELPER_FRAME_HEADER_BYTES + 2) {
    throw invalid("Remote worker POSIX scan helper frame was invalid.");
  }
  const payloadBytes = frame.readUInt32BE(0);
  if (
    payloadBytes < 2 ||
    payloadBytes > maximumPayloadBytes ||
    frame.byteLength !== POSIX_HELPER_FRAME_HEADER_BYTES + payloadBytes
  ) {
    throw invalid("Remote worker POSIX scan helper frame was invalid.");
  }
  const payload = frame.subarray(POSIX_HELPER_FRAME_HEADER_BYTES);
  const text = payload.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payload)) {
    throw invalid("Remote worker POSIX scan helper frame was invalid.");
  }
  return JSON.parse(text) as unknown;
}

function parsePosixScanHelperError(value: unknown, requestId: string): Error | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).ok !== false
  ) {
    return undefined;
  }
  const record = exactRecord(value, ["schemaVersion", "operation", "requestId", "ok", "message"]);
  if (
    record.schemaVersion !== POSIX_HELPER_SCHEMA_VERSION ||
    record.operation !== "error" ||
    record.requestId !== requestId ||
    record.ok !== false ||
    typeof record.message !== "string" ||
    record.message.length < 1 ||
    record.message.length > 512 ||
    /[\0\r\n]/u.test(record.message)
  ) {
    throw invalid("Remote worker POSIX scan helper response was invalid.");
  }
  return invalid(record.message);
}

async function scanWindowsTree(root: string, limits: ScanLimits, deadline: ScanDeadline): Promise<ScannedTree> {
  const visitedDirectories = new Map<string, RemoteWorkerWindowsDirectoryEvidence>();
  const files: RemoteWorkerInstalledTreeFile[] = [];
  const identities = new Set<string>();
  let totalBytes = 0;
  let rootOwnerSid: string | undefined;
  let rootIdentity: string | undefined;

  const walk = async (
    relativeDirectory: string,
    role?: RemoteWorkerInstalledTreeRole,
    expectedDirectory?: RemoteWorkerWindowsFileObservation,
  ): Promise<void> => {
    deadline.check();
    const evidence = await awaitWindowsScanHelper(deadline, async (deadlineMs, signal) =>
      enumerateRemoteWorkerWindowsDirectory(root, relativeDirectory, { deadlineMs, signal }),
    );
    assertSafeWindowsDirectory(evidence.rootObservation, rootOwnerSid);
    rootOwnerSid ??= evidence.rootObservation.ownerSid;
    if (evidence.operatorSid !== rootOwnerSid)
      throw invalid("Remote worker installed-tree root is not operator-owned.");
    const observedRootIdentity = windowsIdentity(evidence.rootObservation);
    rootIdentity ??= observedRootIdentity;
    if (rootIdentity !== observedRootIdentity)
      throw invalid("Remote worker installed-tree root changed during scanning.");
    assertSafeWindowsDirectory(evidence.directoryObservation, rootOwnerSid);
    if (expectedDirectory !== undefined) assertSameWindowsObservation(expectedDirectory, evidence.directoryObservation);
    assertCasefoldUnique(evidence.secondNames);
    visitedDirectories.set(relativeDirectory, evidence);

    if (relativeDirectory === "") {
      if (!equalStrings(evidence.secondNames, REQUIRED_ROOT_DIRECTORIES)) {
        throw invalid("Remote worker installed-tree root layout is invalid.");
      }
      if (evidence.entries.some((entry) => entry.kind !== "directory")) {
        throw invalid("Remote worker installed-tree root contains a file or special entry.");
      }
    } else if (evidence.entries.length === 0) {
      throw invalid("Remote worker installed tree contains an empty directory.");
    }

    for (const entry of evidence.entries) {
      deadline.check();
      if (entry.kind === "reparse" || entry.kind === "special") {
        throw invalid("Remote worker installed tree contains a reparse point or special file.");
      }
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.kind === "directory") {
        if (relativeDirectory === "") {
          const recursiveRole = RECURSIVE_DIRECTORIES.get(entry.name);
          const singletonRole = SINGLETON_DIRECTORIES.get(entry.name);
          await walk(relativePath, recursiveRole ?? singletonRole, entry.observation);
          deadline.check();
          continue;
        }
        if (role === undefined || !RECURSIVE_DIRECTORIES.has(relativeDirectory.split("/", 1)[0] as string)) {
          throw invalid("Remote worker singleton role directory contains nested directories.");
        }
        await walk(relativePath, role, entry.observation);
        deadline.check();
        continue;
      }
      const effectiveRole = role ?? roleForRootFile(relativeDirectory);
      if (effectiveRole === undefined) throw invalid("Remote worker installed-tree file role is invalid.");
      const hashed = await awaitWindowsScanHelper(deadline, async (deadlineMs, signal) =>
        hashRemoteWorkerWindowsFile(root, relativePath, limits.maxFileBytes, { deadlineMs, signal }),
      );
      if (hashed.operatorSid !== rootOwnerSid)
        throw invalid("Remote worker installed-tree root is not operator-owned.");
      const ancestorPaths = windowsAncestorPaths(relativeDirectory);
      if (ancestorPaths.length !== hashed.ancestorsBefore.length) {
        throw invalid("Remote worker Windows file ancestry is incomplete.");
      }
      for (let index = 0; index < hashed.ancestorsBefore.length; index += 1) {
        deadline.check();
        const ancestor = hashed.ancestorsBefore[index] as RemoteWorkerWindowsFileObservation;
        assertSafeWindowsDirectory(ancestor, rootOwnerSid);
        const expected = visitedDirectories.get(ancestorPaths[index] as string)?.directoryObservation;
        if (expected === undefined) throw invalid("Remote worker Windows file ancestry is incomplete.");
        assertSameWindowsObservation(expected, ancestor);
      }
      assertSameWindowsObservation(entry.observation, hashed.before);
      assertSameWindowsObservation(hashed.before, hashed.after);
      assertSafeWindowsRegularFile(hashed.before, rootOwnerSid);
      const identity = windowsIdentity(hashed.before);
      if (identities.has(identity)) throw invalid("Remote worker installed-tree files contain an identity alias.");
      identities.add(identity);
      totalBytes = addBoundedBytes(totalBytes, hashed.sizeBytes, limits.maxTotalBytes);
      if (files.length >= limits.maxFileCount)
        throw invalid("Remote worker installed-tree file count exceeds its limit.");
      const statSha256 = sha256Utf8(canonicalJsonString(hashed.before));
      files.push(
        Object.freeze({
          path: relativePath,
          role: effectiveRole,
          kind: "regular_file",
          sizeBytes: hashed.sizeBytes,
          sha256: hashed.sha256,
          identity,
          beforeStatSha256: statSha256,
          afterStatSha256: statSha256,
          immutable: true,
        }),
      );
    }
  };

  await walk("");
  deadline.check();
  assertRoleCardinality(files);
  for (const [relativeDirectory, initial] of visitedDirectories) {
    deadline.check();
    const repeated = await awaitWindowsScanHelper(deadline, async (deadlineMs, signal) =>
      enumerateRemoteWorkerWindowsDirectory(root, relativeDirectory, { deadlineMs, signal }),
    );
    if (
      rootIdentity !== windowsIdentity(repeated.rootObservation) ||
      !equalStrings(initial.secondNames, repeated.secondNames) ||
      !sameWindowsObservation(initial.directoryObservation, repeated.directoryObservation)
    ) {
      throw invalid("Remote worker installed-tree directory changed during scanning.");
    }
  }
  return Object.freeze({ rootIdentity: rootIdentity as string, files: Object.freeze(files), totalBytes });
}

async function scanPosixTree(root: string, limits: ScanLimits, deadline: ScanDeadline): Promise<ScannedTree> {
  const requestId = randomBytes(16).toString("hex");
  const deadlineMs = deadline.remainingProcessHelperMs();
  const response = await invokeFixedPosixScanHelper(
    Object.freeze({
      schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
      operation: "scan",
      requestId,
      deadlineMs,
      root,
      limits,
    }),
    deadlineMs,
    { signal: deadline.signal, onTerminationRequested: undefined },
  );
  deadline.check();
  return parsePosixScanHelperTree(response, requestId, limits);
}

async function scanPosixTreeInProcess(root: string, limits: ScanLimits, deadline: ScanDeadline): Promise<ScannedTree> {
  const rootChain = await openPosixDirectoryChain(root, deadline);
  deadline.check();
  const retained = [...rootChain];
  const files: RemoteWorkerInstalledTreeFile[] = [];
  const identities = new Set<string>();
  let totalBytes = 0;
  try {
    const rootHandle = rootChain.at(-1);
    if (rootHandle === undefined) throw invalid("Remote worker POSIX root is unavailable.");
    const operatorUid = rootHandle.initialStat.uid;
    const rootIdentity = posixIdentity(rootHandle.initialStat);
    const walk = async (
      directory: PosixDirectoryHandle,
      relativeDirectory: string,
      role?: RemoteWorkerInstalledTreeRole,
    ): Promise<void> => {
      deadline.check();
      const firstNames = await readPosixDirectoryNames(directory, deadline);
      assertCasefoldUnique(firstNames);
      if (relativeDirectory === "" && !equalStrings(firstNames, REQUIRED_ROOT_DIRECTORIES)) {
        throw invalid("Remote worker installed-tree root layout is invalid.");
      }
      if (relativeDirectory !== "" && firstNames.length === 0) {
        throw invalid("Remote worker installed tree contains an empty directory.");
      }
      for (const name of firstNames) {
        deadline.check();
        const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        const descriptorPath = `${directory.descriptorPath}/${name}`;
        const before = snapshotStats(
          await awaitPosixScan(deadline, async () => lstat(descriptorPath, { bigint: true })),
        );
        if (before.kind === "directory") {
          const child = await openPosixDirectoryAt(directory, name, operatorUid, undefined, deadline);
          retained.push(child);
          if (relativeDirectory === "") {
            await walk(child, relativePath, RECURSIVE_DIRECTORIES.get(name) ?? SINGLETON_DIRECTORIES.get(name));
          } else {
            if (role === undefined || !RECURSIVE_DIRECTORIES.has(relativeDirectory.split("/", 1)[0] as string)) {
              throw invalid("Remote worker singleton role directory contains nested directories.");
            }
            await walk(child, relativePath, role);
          }
          deadline.check();
          continue;
        }
        if (before.kind !== "regular_file") {
          throw invalid("Remote worker installed tree contains a symlink or special file.");
        }
        const effectiveRole = role ?? roleForRootFile(relativeDirectory);
        if (effectiveRole === undefined) throw invalid("Remote worker installed-tree file role is invalid.");
        const scanned = await hashPosixFileAt(directory, name, before, operatorUid, limits.maxFileBytes, deadline);
        const identity = posixIdentity(scanned.stat);
        if (identities.has(identity)) throw invalid("Remote worker installed-tree files contain an identity alias.");
        identities.add(identity);
        totalBytes = addBoundedBytes(totalBytes, scanned.sizeBytes, limits.maxTotalBytes);
        if (files.length >= limits.maxFileCount)
          throw invalid("Remote worker installed-tree file count exceeds its limit.");
        const statSha256 = sha256Utf8(canonicalJsonString(scanned.stat));
        files.push(
          Object.freeze({
            path: relativePath,
            role: effectiveRole,
            kind: "regular_file",
            sizeBytes: scanned.sizeBytes,
            sha256: scanned.sha256,
            identity,
            beforeStatSha256: statSha256,
            afterStatSha256: statSha256,
            immutable: true,
          }),
        );
      }
      const secondNames = await readPosixDirectoryNames(directory, deadline);
      if (!equalStrings(firstNames, secondNames))
        throw invalid("Remote worker directory enumeration changed during scanning.");
    };
    await walk(rootHandle, "");
    deadline.check();
    assertRoleCardinality(files);
    for (const directory of retained) {
      deadline.check();
      await revalidatePosixDirectory(directory, operatorUid, deadline);
    }
    return Object.freeze({ rootIdentity, files: Object.freeze(files), totalBytes });
  } finally {
    await closeAll(retained);
  }
}

function parsePosixScanHelperTree(value: unknown, requestId: string, limits: ScanLimits): ScannedTree {
  const response = exactRecord(value, ["schemaVersion", "operation", "requestId", "ok", "tree"]);
  if (
    response.schemaVersion !== POSIX_HELPER_SCHEMA_VERSION ||
    response.operation !== "scan" ||
    response.requestId !== requestId ||
    response.ok !== true
  ) {
    throw invalid("Remote worker POSIX scan helper response binding was invalid.");
  }
  const tree = exactRecord(response.tree, ["rootIdentity", "files", "totalBytes"]);
  const rootIdentity = canonicalPosixIdentity(tree.rootIdentity, "root identity");
  if (!Array.isArray(tree.files) || tree.files.length < 1 || tree.files.length > limits.maxFileCount) {
    throw invalid("Remote worker POSIX scan helper file list was invalid.");
  }
  const files: RemoteWorkerInstalledTreeFile[] = [];
  const paths = new Set<string>();
  const identities = new Set<string>();
  let totalBytes = 0;
  for (const raw of tree.files) {
    const file = exactRecord(raw, [
      "path",
      "role",
      "kind",
      "sizeBytes",
      "sha256",
      "identity",
      "beforeStatSha256",
      "afterStatSha256",
      "immutable",
    ]);
    const path = canonicalPosixHelperRelativePath(file.path);
    if (paths.has(path)) throw invalid("Remote worker POSIX scan helper file path was duplicated.");
    paths.add(path);
    const expectedRole = roleForTopLevelPath(path);
    if (file.role !== expectedRole) throw invalid("Remote worker POSIX scan helper file role was invalid.");
    const sizeBytes = boundedNonNegativeInteger(file.sizeBytes, limits.maxFileBytes, "file size");
    totalBytes = addBoundedBytes(totalBytes, sizeBytes, limits.maxTotalBytes);
    const identity = canonicalPosixIdentity(file.identity, "file identity");
    if (identities.has(identity)) throw invalid("Remote worker POSIX scan helper file identity was duplicated.");
    identities.add(identity);
    const sha256 = canonicalSha256(file.sha256, "file digest");
    const beforeStatSha256 = canonicalSha256(file.beforeStatSha256, "before-stat digest");
    const afterStatSha256 = canonicalSha256(file.afterStatSha256, "after-stat digest");
    if (file.kind !== "regular_file" || file.immutable !== true || beforeStatSha256 !== afterStatSha256) {
      throw invalid("Remote worker POSIX scan helper file evidence was invalid.");
    }
    files.push(
      Object.freeze({
        path,
        role: expectedRole,
        kind: "regular_file",
        sizeBytes,
        sha256,
        identity,
        beforeStatSha256,
        afterStatSha256,
        immutable: true,
      }),
    );
  }
  if (
    !files.every(
      (file, index) => index === 0 || compareFilePaths(files[index - 1] as RemoteWorkerInstalledTreeFile, file) < 0,
    )
  ) {
    throw invalid("Remote worker POSIX scan helper file order was invalid.");
  }
  if (tree.totalBytes !== totalBytes) throw invalid("Remote worker POSIX scan helper total bytes were invalid.");
  assertRoleCardinality(files);
  return Object.freeze({ rootIdentity, files: Object.freeze(files), totalBytes });
}

function canonicalPosixHelperRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    posixPath.normalize(value) !== value
  ) {
    throw invalid("Remote worker POSIX scan helper file path was invalid.");
  }
  for (const segment of value.split("/")) canonicalSegment(segment);
  return value;
}

function roleForTopLevelPath(path: string): RemoteWorkerInstalledTreeRole {
  const topLevel = path.split("/", 1)[0] as string;
  const role = SINGLETON_DIRECTORIES.get(topLevel) ?? RECURSIVE_DIRECTORIES.get(topLevel);
  if (role === undefined) throw invalid("Remote worker POSIX scan helper file role was invalid.");
  if (SINGLETON_DIRECTORIES.has(topLevel) && path.split("/").length !== 2) {
    throw invalid("Remote worker POSIX scan helper singleton path was invalid.");
  }
  return role;
}

function canonicalPosixIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 96 || !/^posix:(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u.test(value)) {
    throw invalid(`Remote worker POSIX scan helper ${label} was invalid.`);
  }
  return value;
}

async function openPosixAbsoluteFile(
  filePath: string,
  maximumBytes: number,
): Promise<{ readonly content: Buffer; readonly ancestors: readonly PosixDirectoryHandle[] }> {
  if (
    typeof filePath !== "string" ||
    !posixPath.isAbsolute(filePath) ||
    posixPath.normalize(filePath) !== filePath ||
    filePath === "/" ||
    filePath.endsWith("/")
  ) {
    throw invalid("Remote worker trust file path is invalid.");
  }
  const parent = posixPath.dirname(filePath);
  const ancestors = await openPosixDirectoryChain(parent);
  const directory = ancestors.at(-1);
  if (directory === undefined) throw invalid("Remote worker trust file parent is unavailable.");
  try {
    const before = snapshotStats(
      await lstat(`${directory.descriptorPath}/${posixPath.basename(filePath)}`, { bigint: true }),
    );
    const scanned = await readPosixFileAt(
      directory,
      posixPath.basename(filePath),
      before,
      directory.initialStat.uid,
      maximumBytes,
    );
    return { content: scanned.content, ancestors };
  } catch (error) {
    await closeAll(ancestors);
    throw error;
  }
}

async function openPosixDirectoryChain(root: string, deadline?: ScanDeadline): Promise<PosixDirectoryHandle[]> {
  if (!posixPath.isAbsolute(root) || posixPath.normalize(root) !== root || root === "/" || root.endsWith("/")) {
    throw invalid("Remote worker POSIX root path is invalid.");
  }
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directoryFlag = (fsConstants as typeof fsConstants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  if (noFollow === 0 || directoryFlag === 0) throw invalid("Required POSIX no-follow primitives are unavailable.");
  try {
    await maybeAwaitPosixScan(deadline, async () => lstat("/proc/self/fd"));
  } catch {
    throw invalid("Required POSIX retained-descriptor traversal is unavailable.");
  }
  const handles: PosixDirectoryHandle[] = [];
  try {
    let currentAbsolute = "/";
    let current = await openPosixDirectoryPath("/", currentAbsolute, noFollow, directoryFlag, deadline);
    handles.push(current);
    const segments = root.slice(1).split("/");
    for (const segment of segments) {
      canonicalSegment(segment);
      currentAbsolute = posixPath.join(currentAbsolute, segment);
      current = await openPosixDirectoryAt(current, segment, undefined, currentAbsolute, deadline);
      handles.push(current);
    }
    const operatorUid = currentPosixOperatorUid();
    if (handles.at(-1)?.initialStat.uid !== operatorUid) {
      throw invalid("Remote worker POSIX root is not operator-owned.");
    }
    for (const handle of handles) assertSafePosixDirectory(handle.initialStat, operatorUid);
    return handles;
  } catch (error) {
    await closeAll(handles);
    throw error;
  }
}

async function openPosixDirectoryPath(
  descriptorPath: string,
  absolutePath: string,
  noFollow: number,
  directoryFlag: number,
  deadline?: ScanDeadline,
): Promise<PosixDirectoryHandle> {
  const before = snapshotStats(
    await maybeAwaitPosixScan(deadline, async () => lstat(descriptorPath, { bigint: true })),
  );
  const handle = await maybeAwaitPosixScan(deadline, async () =>
    open(descriptorPath, fsConstants.O_RDONLY | noFollow | directoryFlag),
  );
  try {
    const opened = snapshotStats(await maybeAwaitPosixScan(deadline, async () => handle.stat({ bigint: true })));
    const after = snapshotStats(
      await maybeAwaitPosixScan(deadline, async () => lstat(descriptorPath, { bigint: true })),
    );
    assertSamePosixStat(before, opened);
    assertSamePosixStat(opened, after);
    return Object.freeze({ handle, absolutePath, descriptorPath: `/proc/self/fd/${handle.fd}`, initialStat: opened });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openPosixDirectoryAt(
  parent: PosixDirectoryHandle,
  name: string,
  operatorUid: number | undefined,
  absolutePath = posixPath.join(parent.absolutePath, name),
  deadline?: ScanDeadline,
): Promise<PosixDirectoryHandle> {
  canonicalSegment(name);
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directoryFlag = (fsConstants as typeof fsConstants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  if (noFollow === 0 || directoryFlag === 0) throw invalid("Required POSIX no-follow primitives are unavailable.");
  const opened = await openPosixDirectoryPath(
    `${parent.descriptorPath}/${name}`,
    absolutePath,
    noFollow,
    directoryFlag,
    deadline,
  );
  if (operatorUid !== undefined) assertSafePosixDirectory(opened.initialStat, operatorUid);
  return opened;
}

async function hashPosixFileAt(
  parent: PosixDirectoryHandle,
  name: string,
  before: PosixStatSnapshot,
  operatorUid: number,
  maximumBytes: number,
  deadline: ScanDeadline,
): Promise<{ readonly sha256: string; readonly sizeBytes: number; readonly stat: PosixStatSnapshot }> {
  deadline.check();
  canonicalSegment(name);
  assertSafePosixRegularFile(before, operatorUid);
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  if (noFollow === 0) throw invalid("Required POSIX no-follow primitives are unavailable.");
  const descriptorPath = `${parent.descriptorPath}/${name}`;
  const handle = await awaitPosixScan(deadline, async () => open(descriptorPath, fsConstants.O_RDONLY | noFollow));
  try {
    const opened = snapshotStats(await awaitPosixScan(deadline, async () => handle.stat({ bigint: true })));
    assertSamePosixStat(before, opened);
    assertSafePosixRegularFile(opened, operatorUid);
    const sizeBytes = Number(opened.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maximumBytes) {
      throw invalid("Remote worker file exceeds its byte limit.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(POSIX_READ_BUFFER_BYTES);
    let offset = 0;
    try {
      while (offset < sizeBytes) {
        deadline.check();
        const length = Math.min(buffer.byteLength, sizeBytes - offset);
        const result = await awaitPosixScan(deadline, async () => handle.read(buffer, 0, length, offset));
        if (result.bytesRead < 1) throw invalid("Remote worker file changed during scanning.");
        digest.update(buffer.subarray(0, result.bytesRead));
        buffer.fill(0, 0, result.bytesRead);
        offset += result.bytesRead;
        deadline.check();
      }
      const eof = await awaitPosixScan(deadline, async () => handle.read(buffer, 0, 1, sizeBytes));
      if (eof.bytesRead !== 0) throw invalid("Remote worker file changed during scanning.");
    } finally {
      buffer.fill(0);
    }
    const afterHandle = snapshotStats(await awaitPosixScan(deadline, async () => handle.stat({ bigint: true })));
    const afterPath = snapshotStats(
      await awaitPosixScan(deadline, async () => lstat(descriptorPath, { bigint: true })),
    );
    assertSamePosixStat(opened, afterHandle);
    assertSamePosixStat(afterHandle, afterPath);
    deadline.check();
    return Object.freeze({ sha256: digest.digest("hex"), sizeBytes, stat: afterHandle });
  } finally {
    await handle.close();
  }
}

async function readPosixFileAt(
  parent: PosixDirectoryHandle,
  name: string,
  before: PosixStatSnapshot,
  operatorUid: number,
  maximumBytes: number,
): Promise<{ readonly content: Buffer; readonly stat: PosixStatSnapshot }> {
  canonicalSegment(name);
  assertSafePosixRegularFile(before, operatorUid);
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  if (noFollow === 0) throw invalid("Required POSIX no-follow primitives are unavailable.");
  const descriptorPath = `${parent.descriptorPath}/${name}`;
  const handle = await open(descriptorPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = snapshotStats(await handle.stat({ bigint: true }));
    assertSamePosixStat(before, opened);
    assertSafePosixRegularFile(opened, operatorUid);
    const sizeBytes = Number(opened.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maximumBytes)
      throw invalid("Remote worker file exceeds its byte limit.");
    const content = Buffer.alloc(sizeBytes);
    let retainContent = false;
    try {
      const buffer = Buffer.alloc(Math.min(POSIX_READ_BUFFER_BYTES, Math.max(sizeBytes, 1)));
      let offset = 0;
      try {
        while (offset < sizeBytes) {
          const length = Math.min(buffer.byteLength, sizeBytes - offset);
          const result = await handle.read(buffer, 0, length, offset);
          if (result.bytesRead < 1) throw invalid("Remote worker file changed during scanning.");
          buffer.copy(content, offset, 0, result.bytesRead);
          offset += result.bytesRead;
        }
        const eof = await handle.read(buffer, 0, 1, sizeBytes);
        if (eof.bytesRead !== 0) throw invalid("Remote worker file changed during scanning.");
      } finally {
        buffer.fill(0);
      }
      const afterHandle = snapshotStats(await handle.stat({ bigint: true }));
      const afterPath = snapshotStats(await lstat(descriptorPath, { bigint: true }));
      assertSamePosixStat(opened, afterHandle);
      assertSamePosixStat(afterHandle, afterPath);
      retainContent = true;
      return { content, stat: afterHandle };
    } finally {
      if (!retainContent) content.fill(0);
    }
  } finally {
    await handle.close();
  }
}

async function readPosixDirectoryNames(directory: PosixDirectoryHandle, deadline?: ScanDeadline): Promise<string[]> {
  const entries = (await maybeAwaitPosixScan(deadline, async () =>
    readdir(directory.descriptorPath, {
      encoding: "buffer",
      withFileTypes: true,
    }),
  )) as Dirent<Buffer>[];
  const names = entries.map((entry) => {
    const bytes = entry.name;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > 255) {
      throw invalid("Remote worker directory entry name is invalid.");
    }
    const name = bytes.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(bytes)) throw invalid("Remote worker directory entry is not valid UTF-8.");
    return canonicalSegment(name);
  });
  names.sort(compareUtf8);
  return names;
}

async function revalidatePosixDirectory(
  directory: PosixDirectoryHandle,
  operatorUid: number,
  deadline?: ScanDeadline,
): Promise<void> {
  const descriptor = snapshotStats(
    await maybeAwaitPosixScan(deadline, async () => directory.handle.stat({ bigint: true })),
  );
  const path = snapshotStats(
    await maybeAwaitPosixScan(deadline, async () => lstat(directory.absolutePath, { bigint: true })),
  );
  assertSamePosixStat(directory.initialStat, descriptor);
  assertSamePosixStat(descriptor, path);
  assertSafePosixDirectory(descriptor, operatorUid);
}

function snapshotStats(stat: BigIntStats): PosixStatSnapshot {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode),
    linkCount: stat.nlink.toString(),
    sizeBytes: stat.size.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    uid: Number(stat.uid),
    kind: stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "regular_file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "special",
  });
}

function assertSafePosixDirectory(stat: PosixStatSnapshot, operatorUid: number): void {
  if (stat.kind !== "directory" || (stat.uid !== operatorUid && stat.uid !== 0) || (stat.mode & 0o022) !== 0) {
    throw invalid("Remote worker POSIX directory ancestry is not safely owned.");
  }
}

function assertSafePosixRegularFile(stat: PosixStatSnapshot, operatorUid: number): void {
  if (stat.kind !== "regular_file" || stat.uid !== operatorUid || stat.linkCount !== "1" || (stat.mode & 0o022) !== 0) {
    throw invalid("Remote worker POSIX file is linked, special, or not safely owned.");
  }
}

function assertSamePosixStat(left: PosixStatSnapshot, right: PosixStatSnapshot): void {
  if (canonicalJsonString(left) !== canonicalJsonString(right)) {
    throw invalid("Remote worker POSIX filesystem identity changed during scanning.");
  }
}

function assertSafeWindowsDirectory(observation: RemoteWorkerWindowsFileObservation, expectedOwnerSid?: string): void {
  assertSafeWindowsCommon(observation, expectedOwnerSid);
  if (
    (observation.attributes & WINDOWS_DIRECTORY_ATTRIBUTE) === 0 ||
    (observation.attributes & (WINDOWS_REPARSE_ATTRIBUTE | WINDOWS_DEVICE_ATTRIBUTE)) !== 0 ||
    observation.reparseTag !== 0 ||
    observation.streams.length !== 0
  ) {
    throw invalid("Remote worker Windows directory is a reparse point or special entry.");
  }
}

function assertSafeWindowsRegularFile(
  observation: RemoteWorkerWindowsFileObservation,
  expectedOwnerSid?: string,
): void {
  assertSafeWindowsCommon(observation, expectedOwnerSid);
  if (
    (observation.attributes & (WINDOWS_DIRECTORY_ATTRIBUTE | WINDOWS_REPARSE_ATTRIBUTE | WINDOWS_DEVICE_ATTRIBUTE)) !==
      0 ||
    observation.reparseTag !== 0 ||
    observation.linkCount !== 1 ||
    observation.streams.length !== 1 ||
    observation.streams[0] !== "::$DATA"
  ) {
    throw invalid("Remote worker Windows file is linked, reparse-backed, special, or has an alternate stream.");
  }
}

function assertSafeWindowsCommon(observation: RemoteWorkerWindowsFileObservation, expectedOwnerSid?: string): void {
  if (expectedOwnerSid !== undefined && observation.ownerSid !== expectedOwnerSid) {
    throw invalid("Remote worker Windows filesystem owner changed during scanning.");
  }
  assertNoWritableForeignAcl(observation.sddl, observation.ownerSid);
}

function assertNoWritableForeignAcl(sddl: string, ownerSid: string): void {
  const allowedWriters = new Set([ownerSid, "SY", "BA"]);
  const daclMarker = sddl.indexOf("D:");
  if (daclMarker < 0) throw invalid("Remote worker Windows ACL is incomplete.");
  const saclMarker = sddl.indexOf("S:", daclMarker + 2);
  const dacl = sddl.slice(daclMarker + 2, saclMarker < 0 ? undefined : saclMarker);
  const firstAce = dacl.indexOf("(");
  if (firstAce < 0 || !/^(?:(?:P|AI|AR))*$/u.test(dacl.slice(0, firstAce))) {
    throw invalid("Remote worker Windows ACL is incomplete or unrecognized.");
  }
  const aceBodies: string[] = [];
  let cursor = firstAce;
  while (cursor < dacl.length) {
    if (dacl[cursor] !== "(") throw invalid("Remote worker Windows ACL contains malformed ACE data.");
    const close = dacl.indexOf(")", cursor + 1);
    if (close < 0 || dacl.slice(cursor + 1, close).includes("(") || dacl.slice(cursor + 1, close).includes(")")) {
      throw invalid("Remote worker Windows ACL contains a callback or conditional ACE.");
    }
    aceBodies.push(dacl.slice(cursor + 1, close));
    cursor = close + 1;
  }
  for (const body of aceBodies) {
    const fields = body.split(";");
    if (fields.length !== 6) throw invalid("Remote worker Windows ACL contains malformed ACE data.");
    const [type, flags, rights, objectGuid, inheritObjectGuid, sid] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (type !== "A" && type !== "OA" && type !== "D" && type !== "OD") {
      throw invalid("Remote worker Windows ACL contains an unsupported ACE type.");
    }
    if (!/^(?:(?:CI|OI|NP|IO|ID|SA|FA))*$/u.test(flags)) {
      throw invalid("Remote worker Windows ACL contains unsupported ACE flags.");
    }
    if ((type === "A" || type === "D") && (objectGuid !== "" || inheritObjectGuid !== "")) {
      throw invalid("Remote worker Windows ACL contains malformed object ACE data.");
    }
    if (
      (objectGuid !== "" && !isCanonicalWindowsGuid(objectGuid)) ||
      (inheritObjectGuid !== "" && !isCanonicalWindowsGuid(inheritObjectGuid))
    ) {
      throw invalid("Remote worker Windows ACL contains malformed object ACE data.");
    }
    if (!isCanonicalWindowsSidOrAlias(sid)) throw invalid("Remote worker Windows ACL contains an invalid SID.");
    const writes = grantsWindowsWrite(rights);
    if ((type === "A" || type === "OA") && !allowedWriters.has(sid) && writes) {
      throw invalid("Remote worker Windows ACL permits non-operator writes.");
    }
  }
}

function grantsWindowsWrite(rights: string): boolean {
  if (/^0x[0-9a-f]+$/iu.test(rights)) {
    const mask = Number.parseInt(rights.slice(2), 16);
    return (mask & 0x500d0156) !== 0;
  }
  if (rights.length < 2 || rights.length % 2 !== 0) {
    throw invalid("Remote worker Windows ACL contains unsupported access rights.");
  }
  const known = new Set([
    "GA",
    "GR",
    "GW",
    "GX",
    "RC",
    "SD",
    "WD",
    "WO",
    "RP",
    "WP",
    "CC",
    "DC",
    "LC",
    "SW",
    "LO",
    "DT",
    "CR",
    "FA",
    "FR",
    "FW",
    "FX",
    "KA",
    "KR",
    "KW",
    "KX",
    "NR",
    "NW",
    "NX",
  ]);
  const writeCapable = new Set([
    "GA",
    "GW",
    "SD",
    "WD",
    "WO",
    "WP",
    "CC",
    "DC",
    "SW",
    "DT",
    "CR",
    "FA",
    "FW",
    "KA",
    "KW",
  ]);
  let writes = false;
  for (let index = 0; index < rights.length; index += 2) {
    const code = rights.slice(index, index + 2);
    if (!known.has(code)) throw invalid("Remote worker Windows ACL contains unsupported access rights.");
    if (writeCapable.has(code)) writes = true;
  }
  return writes;
}

function isCanonicalWindowsGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isCanonicalWindowsSidOrAlias(value: string): boolean {
  return /^(?:S-1-(?:\d+-)*\d+|SY|BA|BU|WD|AU|AN|BG|BO|CO|CG|OW)$/u.test(value);
}

function windowsIdentity(observation: RemoteWorkerWindowsFileObservation): string {
  return `windows:${observation.volumeSerial}:${observation.fileId}`;
}

function windowsAncestorPaths(relativeDirectory: string): string[] {
  if (relativeDirectory === "") return [""];
  const segments = relativeDirectory.split("/");
  const paths = [""];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    paths.push(current);
  }
  return paths;
}

function assertSameWindowsObservation(
  left: RemoteWorkerWindowsFileObservation,
  right: RemoteWorkerWindowsFileObservation,
): void {
  if (!sameWindowsObservation(left, right)) throw invalid("Remote worker Windows file changed during scanning.");
}

function sameWindowsObservation(
  left: RemoteWorkerWindowsFileObservation,
  right: RemoteWorkerWindowsFileObservation,
): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}

function roleForRootFile(relativeDirectory: string): RemoteWorkerInstalledTreeRole | undefined {
  return SINGLETON_DIRECTORIES.get(relativeDirectory) ?? RECURSIVE_DIRECTORIES.get(relativeDirectory);
}

function assertRoleCardinality(files: readonly RemoteWorkerInstalledTreeFile[]): void {
  for (const role of ["bundle", "dependency_lock", "launcher"] as const) {
    if (files.filter((file) => file.role === role).length !== 1) {
      throw invalid("Remote worker singleton role does not contain exactly one file.");
    }
  }
  for (const role of ["vendor", "runtime"] as const) {
    if (!files.some((file) => file.role === role)) throw invalid("Remote worker recursive role has no files.");
  }
}

function normalizeLimits(input: {
  readonly maxFileCount: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}): ScanLimits {
  return Object.freeze({
    maxFileCount: boundedPositiveInteger(input.maxFileCount, 100_000, "file count limit"),
    maxFileBytes: boundedPositiveInteger(input.maxFileBytes, 512 * 1024 * 1024, "file byte limit"),
    maxTotalBytes: boundedPositiveInteger(input.maxTotalBytes, 4 * 1024 * 1024 * 1024, "total byte limit"),
  });
}

function createScanDeadline(requestedMs: number | undefined, signal?: AbortSignal): ScanDeadline {
  const durationMs =
    requestedMs === undefined
      ? FIXED_SCAN_DEADLINE_MS
      : boundedPositiveInteger(requestedMs, FIXED_SCAN_DEADLINE_MS, "scan deadline");
  const expiresAt = performance.now() + durationMs;
  const check = (): void => {
    if (signal?.aborted === true) throw invalid("Remote worker installed-tree scan was aborted.");
    if (performance.now() >= expiresAt) throw invalid("Remote worker installed-tree scan exceeded its deadline.");
  };
  const remainingMs = (): number => {
    check();
    const remaining = Math.ceil(expiresAt - performance.now());
    if (remaining < 1) throw invalid("Remote worker installed-tree scan exceeded its deadline.");
    return Math.min(remaining, FIXED_SCAN_DEADLINE_MS);
  };
  return Object.freeze({
    check,
    signal,
    remainingWindowsHelperMs: (): number => {
      const remaining = remainingMs();
      if (remaining < MINIMUM_WINDOWS_HELPER_DEADLINE_MS) {
        throw invalid("Remote worker installed-tree scan exceeded its deadline.");
      }
      return remaining;
    },
    remainingProcessHelperMs: remainingMs,
  });
}

async function awaitWindowsScanHelper<T>(
  deadline: ScanDeadline,
  operation: (deadlineMs: number, signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  deadline.check();
  try {
    const value = await operation(deadline.remainingWindowsHelperMs(), deadline.signal);
    deadline.check();
    return value;
  } catch (error) {
    deadline.check();
    throw error;
  }
}

async function awaitPosixScan<T>(deadline: ScanDeadline, operation: () => Promise<T>): Promise<T> {
  deadline.check();
  const value = await operation();
  deadline.check();
  return value;
}

async function maybeAwaitPosixScan<T>(deadline: ScanDeadline | undefined, operation: () => Promise<T>): Promise<T> {
  return deadline === undefined ? await operation() : await awaitPosixScan(deadline, operation);
}

function canonicalRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid("Remote worker installed-tree root is invalid.");
  }
  return value;
}

function canonicalSegment(value: string): string {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value.normalize("NFC") !== value ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\p{Cc}]/u.test(value) ||
    /[ .]$/u.test(value) ||
    isWindowsReserved(value)
  ) {
    throw invalid("Remote worker installed-tree path segment is invalid.");
  }
  return value;
}

function isWindowsReserved(value: string): boolean {
  const base = value.split(".", 1)[0]?.normalize("NFKC").toLocaleUpperCase("en-US");
  return base !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function assertCasefoldUnique(names: readonly string[]): void {
  const folded = new Set<string>();
  for (const name of names) {
    const key = name.normalize("NFKC").toLocaleUpperCase("en-US").toLocaleLowerCase("en-US").normalize("NFC");
    if (folded.has(key)) throw invalid("Remote worker installed tree contains a case-fold collision.");
    folded.add(key);
  }
}

function canonicalClock(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw invalid("Remote worker scanner clock is invalid.");
  return value.toISOString();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Remote worker POSIX scan helper record was invalid.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("Remote worker POSIX scan helper record was invalid.");
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (!equalStrings(actualKeys, expectedKeys)) {
    throw invalid("Remote worker POSIX scan helper record was invalid.");
  }
  return value as Record<string, unknown>;
}

function canonicalSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value as number;
}

function boundedNonNegativeInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw invalid(`Remote worker POSIX scan helper ${label} was invalid.`);
  }
  return value as number;
}

function currentPosixOperatorUid(): number {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
    throw invalid("Remote worker POSIX operator ownership is unavailable.");
  }
  return uid as number;
}

function addBoundedBytes(current: number, additional: number, maximum: number): number {
  const result = current + additional;
  if (!Number.isSafeInteger(result) || result > maximum)
    throw invalid("Remote worker installed-tree total bytes exceed the limit.");
  return result;
}

function posixIdentity(stat: PosixStatSnapshot): string {
  return `posix:${stat.device}:${stat.inode}`;
}

function compareFilePaths(left: RemoteWorkerInstalledTreeFile, right: RemoteWorkerInstalledTreeFile): number {
  return compareUtf8(left.path, right.path);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function closeAll(handles: readonly PosixDirectoryHandle[]): Promise<void> {
  await Promise.allSettled([...handles].reverse().map(async (entry) => entry.handle.close()));
}

async function runPosixScanHelperProcess(): Promise<void> {
  let requestId = "0".repeat(32);
  let response: Readonly<Record<string, unknown>>;
  try {
    const requestFrame = await readPosixHelperStdin();
    let raw: unknown;
    try {
      raw = decodePosixHelperFrame(requestFrame, POSIX_HELPER_MAX_REQUEST_BYTES);
    } finally {
      requestFrame.fill(0);
    }
    const request = parsePosixHelperRequest(raw);
    requestId = request.requestId;
    if (request.operation === "probe") {
      if (request.probeBehavior === "hang") {
        await writePosixHelperOutput(
          Object.freeze({
            schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
            operation: "probe_ready",
            requestId,
            ok: true,
          }),
        );
        await new Promise<never>(() => {
          setInterval(() => undefined, 60_000);
        });
      }
      response = Object.freeze({
        schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
        operation: "probe",
        requestId,
        ok: true,
      });
    } else {
      if (process.platform === "win32") throw invalid("Remote worker POSIX scanning is unavailable on this platform.");
      const tree = await scanPosixTreeInProcess(
        request.root as string,
        request.limits as ScanLimits,
        createScanDeadline(request.deadlineMs),
      );
      const canonicalTree = Object.freeze({
        ...tree,
        files: Object.freeze([...tree.files].sort(compareFilePaths)),
      });
      response = Object.freeze({
        schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
        operation: "scan",
        requestId,
        ok: true,
        tree: canonicalTree,
      });
    }
  } catch (error) {
    const message =
      error instanceof RemoteWorkerInstalledTreeScannerError
        ? error.message
        : "Remote worker POSIX scan helper failed.";
    response = Object.freeze({
      schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
      operation: "error",
      requestId,
      ok: false,
      message,
    });
  }
  try {
    await writePosixHelperOutput(response);
  } catch {
    await writePosixHelperOutput(
      Object.freeze({
        schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
        operation: "error",
        requestId,
        ok: false,
        message: "Remote worker POSIX scan helper response exceeded its byte limit.",
      }),
    );
  }
}

async function writePosixHelperOutput(response: Readonly<Record<string, unknown>>): Promise<void> {
  const frame = encodePosixHelperFrame(response, POSIX_HELPER_MAX_RESPONSE_BYTES);
  try {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(frame, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  } finally {
    frame.fill(0);
  }
}

async function readPosixHelperStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw as string, "utf8");
      received += chunk.byteLength;
      if (received > POSIX_HELPER_MAX_REQUEST_BYTES + POSIX_HELPER_FRAME_HEADER_BYTES) {
        chunk.fill(0);
        throw invalid("Remote worker POSIX scan helper request exceeded its byte limit.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, received);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function parsePosixHelperRequest(value: unknown): PosixScanHelperRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Remote worker POSIX scan helper request was invalid.");
  }
  const operation = (value as Record<string, unknown>).operation;
  if (operation === "probe") {
    const record = exactRecord(value, ["schemaVersion", "operation", "requestId", "deadlineMs", "probeBehavior"]);
    if (
      process.env[POSIX_HELPER_TEST_GUARD] !== "1" ||
      record.schemaVersion !== POSIX_HELPER_SCHEMA_VERSION ||
      (record.probeBehavior !== "success" && record.probeBehavior !== "hang")
    ) {
      throw invalid("Remote worker POSIX scan helper request was invalid.");
    }
    return Object.freeze({
      schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
      operation: "probe",
      requestId: canonicalPosixHelperRequestId(record.requestId),
      deadlineMs: boundedPositiveInteger(record.deadlineMs, FIXED_SCAN_DEADLINE_MS, "scan deadline"),
      probeBehavior: record.probeBehavior,
    });
  }
  const record = exactRecord(value, ["schemaVersion", "operation", "requestId", "deadlineMs", "root", "limits"]);
  if (record.schemaVersion !== POSIX_HELPER_SCHEMA_VERSION || record.operation !== "scan") {
    throw invalid("Remote worker POSIX scan helper request was invalid.");
  }
  const rawLimits = exactRecord(record.limits, ["maxFileCount", "maxFileBytes", "maxTotalBytes"]);
  return Object.freeze({
    schemaVersion: POSIX_HELPER_SCHEMA_VERSION,
    operation: "scan",
    requestId: canonicalPosixHelperRequestId(record.requestId),
    deadlineMs: boundedPositiveInteger(record.deadlineMs, FIXED_SCAN_DEADLINE_MS, "scan deadline"),
    root: canonicalRoot(record.root),
    limits: normalizeLimits({
      maxFileCount: rawLimits.maxFileCount as number,
      maxFileBytes: rawLimits.maxFileBytes as number,
      maxTotalBytes: rawLimits.maxTotalBytes as number,
    }),
  });
}

function canonicalPosixHelperRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
    throw invalid("Remote worker POSIX scan helper request binding was invalid.");
  }
  return value;
}

const POSIX_HELPER_MODULE_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] === POSIX_HELPER_MODULE_PATH && process.argv[2] === POSIX_HELPER_ENTRYPOINT_FLAG) {
  void runPosixScanHelperProcess().catch(() => {
    process.exitCode = 1;
  });
}

function invalid(message: string): RemoteWorkerInstalledTreeScannerError {
  return new RemoteWorkerInstalledTreeScannerError(message);
}
