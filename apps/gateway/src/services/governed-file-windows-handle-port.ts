import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { win32 as path } from "node:path";
import { gzipSync } from "node:zlib";
import { buildPowerShellProgram } from "./governed-file-windows-handle-port-program.js";
import { GOVERNED_FILE_HANDLE_PORT_SCHEMA_VERSION } from "./governed-file-windows-handle-port-schema.js";

/**
 * Native handle-relative capture/publish/restore port for governed file
 * recipes (Windows).
 *
 * Node's path-based fs API cannot prove a handle-bound, no-follow atomic
 * capture or publish across a concurrent parent-directory/reparse swap. This
 * port follows the repo's established native pattern
 * (remote-worker-windows-no-follow.ts): a fixed System32 Windows PowerShell
 * helper hosts a strictly-bounded C# win32 syscall wrapper that
 *
 * 1. walks every path segment with NtCreateFile relative to the previous
 *    directory handle using OBJ_DONT_REPARSE + FILE_OPEN_REPARSE_POINT and
 *    refuses any reparse point instead of following it;
 * 2. captures entry bytes and volume/file identity through those handles;
 * 3. publishes a replacement atomically by writing a temp file created
 *    relative to the pinned parent handle and renaming it over the entry with
 *    NtSetInformationFile(FileRenameInformationEx) using
 *    FILE_RENAME_POSIX_SEMANTICS and RootDirectory = the pinned parent handle;
 * 4. restores by publishing the previously captured bytes (or removing a
 *    created entry) under the same compare-and-swap discipline.
 *
 * Because verification and mutation reuse the held handles inside one helper
 * invocation, a parent/reparse swap between check and use cannot redirect the
 * capture or publish target: the walk either refuses (typed refusal, no
 * effect) or the mutation lands inside the originally pinned parent.
 */

const SCHEMA_VERSION = GOVERNED_FILE_HANDLE_PORT_SCHEMA_VERSION;
const DEFAULT_DEADLINE_MS = 15_000;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_PROTOCOL_REQUEST_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROGRAM_ENV_NAME = "GOATCITADEL_GOVERNED_FILE_HANDLE_PORT_PROGRAM";
const POWERSHELL_PROGRAM = buildPowerShellProgram();
const POWERSHELL_PROGRAM_GZIP = gzipSync(Buffer.from(POWERSHELL_PROGRAM, "utf8"), { level: 9 }).toString("base64");
const POWERSHELL_BOOTSTRAP = [
  `$compressed=[Convert]::FromBase64String([Environment]::GetEnvironmentVariable('${PROGRAM_ENV_NAME}'))`,
  "$memory=[IO.MemoryStream]::new($compressed)",
  "$gzip=[IO.Compression.GzipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress)",
  "$reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8)",
  "$program=$reader.ReadToEnd()",
  "$reader.Dispose();$gzip.Dispose();$memory.Dispose()",
  "& ([ScriptBlock]::Create($program))",
].join(";");
const POWERSHELL_ENCODED_BOOTSTRAP = Buffer.from(POWERSHELL_BOOTSTRAP, "utf16le").toString("base64");

let helperRunning = false;

export const GOVERNED_FILE_HANDLE_PORT_REFUSAL_REASONS = [
  "reparse_refused",
  "parent_identity_changed",
  "entry_identity_changed",
  "precondition_drift",
  "presence_conflict",
  "entry_kind_invalid",
  "posix_semantics_unsupported",
] as const;
export type GovernedFileHandlePortRefusalReason = (typeof GOVERNED_FILE_HANDLE_PORT_REFUSAL_REASONS)[number];

export interface GovernedFileHandleObservation {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly sizeBytes: number;
  readonly linkCount: number;
  readonly attributes: number;
  readonly reparseTag: number;
  readonly lastWriteTime: string;
  readonly changeTime: string;
}

export interface GovernedFileHandleIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
}

export interface GovernedFileCaptureEvidence {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly parent: GovernedFileHandleObservation;
  readonly present: boolean;
  readonly entry: GovernedFileHandleObservation | null;
  readonly content: Buffer | null;
  readonly sha256: string | null;
}

export interface GovernedFilePublishEvidence {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly parent: GovernedFileHandleObservation;
  readonly priorPresent: boolean;
  readonly priorSha256: string | null;
  readonly published: GovernedFileHandleObservation;
  readonly publishedSha256: string;
  readonly renameMechanism: "posix_handle_rename";
}

export interface GovernedFileRemoveEvidence {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly parent: GovernedFileHandleObservation;
  readonly priorSha256: string;
  readonly removed: true;
}

export type GovernedFileExpectedPrior =
  | { readonly present: true; readonly sha256: string }
  | { readonly present: false };

export interface GovernedFileHandlePortOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** Protocol/process failure: the operation outcome is unknown to the caller. */
export class GovernedFileHandlePortError extends Error {
  readonly code = "GOVERNED_FILE_HANDLE_PORT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "GovernedFileHandlePortError";
  }
}

/** Typed pre-effect refusal: the helper proved that no mutation happened. */
export class GovernedFileHandlePortRefusalError extends Error {
  readonly code = "GOVERNED_FILE_HANDLE_PORT_REFUSED";

  constructor(public readonly reason: GovernedFileHandlePortRefusalReason) {
    super(`Governed file handle operation refused: ${reason}.`);
    this.name = "GovernedFileHandlePortRefusalError";
  }
}

/** Post-effect witness failure: a mutation may have crossed the boundary. */
export class GovernedFileHandlePortUncertainError extends Error {
  readonly code = "GOVERNED_FILE_HANDLE_PORT_UNCERTAIN";

  constructor(public readonly reason: string) {
    super(`Governed file handle operation outcome is uncertain: ${reason}.`);
    this.name = "GovernedFileHandlePortUncertainError";
  }
}

export function isGovernedFileHandlePortAvailable(): boolean {
  return process.platform === "win32";
}

export async function captureGovernedFileEntry(
  rootPath: string,
  relativePath: string,
  options: GovernedFileHandlePortOptions = {},
): Promise<GovernedFileCaptureEvidence> {
  const root = canonicalLocalDrivePath(rootPath);
  const relative = canonicalEntryRelativePath(relativePath);
  const raw = await invokeFixedHelper(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: "capture",
      rootPath: root,
      relativePath: relative,
      maxBytes: MAX_ENTRY_BYTES,
    }),
    options,
  );
  return parseCaptureResponse(raw, root, relative);
}

export async function publishGovernedFileEntry(
  input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: GovernedFileHandleIdentity;
    readonly expectedPrior: GovernedFileExpectedPrior;
    readonly content: Buffer;
  },
  options: GovernedFileHandlePortOptions = {},
): Promise<GovernedFilePublishEvidence> {
  const root = canonicalLocalDrivePath(input.rootPath);
  const relative = canonicalEntryRelativePath(input.relativePath);
  if (!Buffer.isBuffer(input.content) || input.content.byteLength < 1 || input.content.byteLength > MAX_ENTRY_BYTES) {
    throw invalid("entry content byte bound");
  }
  const expectedParent = canonicalIdentity(input.expectedParent);
  const expectedPrior = canonicalExpectedPrior(input.expectedPrior);
  const raw = await invokeFixedHelper(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: "publish",
      rootPath: root,
      relativePath: relative,
      maxBytes: MAX_ENTRY_BYTES,
      expectedParentVolumeSerial: expectedParent.volumeSerial,
      expectedParentFileId: expectedParent.fileId,
      expectedPriorPresent: expectedPrior.present,
      expectedPriorSha256: expectedPrior.present ? expectedPrior.sha256 : "",
      contentBase64: input.content.toString("base64"),
    }),
    options,
  );
  const evidence = parsePublishResponse(raw, root, relative, expectedPrior);
  if (evidence.publishedSha256 !== sha256Of(input.content)) {
    throw new GovernedFileHandlePortUncertainError("published content hash mismatch");
  }
  return evidence;
}

/** Restore is publish of the previously captured bytes under the same CAS. */
export async function restoreGovernedFileEntry(
  input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: GovernedFileHandleIdentity;
    /** The bytes the failed publish put in place, proving rollback targets it. */
    readonly expectedPrior: GovernedFileExpectedPrior;
    readonly capturedContent: Buffer;
  },
  options: GovernedFileHandlePortOptions = {},
): Promise<GovernedFilePublishEvidence> {
  return publishGovernedFileEntry(
    {
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      expectedParent: input.expectedParent,
      expectedPrior: input.expectedPrior,
      content: input.capturedContent,
    },
    options,
  );
}

export async function removeGovernedFileEntry(
  input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: GovernedFileHandleIdentity;
    readonly expectedSha256: string;
  },
  options: GovernedFileHandlePortOptions = {},
): Promise<GovernedFileRemoveEvidence> {
  const root = canonicalLocalDrivePath(input.rootPath);
  const relative = canonicalEntryRelativePath(input.relativePath);
  const expectedParent = canonicalIdentity(input.expectedParent);
  const expectedSha256 = canonicalHex(input.expectedSha256, 64, "expected content SHA-256");
  const raw = await invokeFixedHelper(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: "remove",
      rootPath: root,
      relativePath: relative,
      maxBytes: MAX_ENTRY_BYTES,
      expectedParentVolumeSerial: expectedParent.volumeSerial,
      expectedParentFileId: expectedParent.fileId,
      expectedPriorSha256: expectedSha256,
    }),
    options,
  );
  return parseRemoveResponse(raw, root, relative, expectedSha256);
}

/** Pure protocol validation for deterministic tests. It is not filesystem authority. */
export function validateGovernedFileHandlePortResponse(
  value: unknown,
  expected:
    | { readonly operation: "capture"; readonly rootPath: string; readonly relativePath: string }
    | {
        readonly operation: "publish";
        readonly rootPath: string;
        readonly relativePath: string;
        readonly expectedPrior: GovernedFileExpectedPrior;
      }
    | {
        readonly operation: "remove";
        readonly rootPath: string;
        readonly relativePath: string;
        readonly expectedSha256: string;
      },
): GovernedFileCaptureEvidence | GovernedFilePublishEvidence | GovernedFileRemoveEvidence {
  const root = canonicalLocalDrivePath(expected.rootPath);
  const relative = canonicalEntryRelativePath(expected.relativePath);
  if (expected.operation === "capture") return parseCaptureResponse(value, root, relative);
  if (expected.operation === "publish") {
    return parsePublishResponse(value, root, relative, canonicalExpectedPrior(expected.expectedPrior));
  }
  return parseRemoveResponse(value, root, relative, canonicalHex(expected.expectedSha256, 64, "expected SHA-256"));
}

/** Secret-free diagnostics proving the helper command is fixed and non-PATH-resolved. */
export function governedFileHandlePortDiagnostics(): Readonly<{
  executableKind: "system32_windows_powershell";
  encodedProgramSha256InputBytes: number;
  relativeHandleWalker: true;
  posixRenameByHandle: true;
  reparseRefusal: true;
  maximumEntryBytes: number;
  maximumProtocolRequestBytes: number;
  maximumProtocolResponseBytes: number;
  nativeFixedVolumeRootOnly: true;
  active: boolean;
}> {
  return Object.freeze({
    executableKind: "system32_windows_powershell",
    encodedProgramSha256InputBytes: Buffer.byteLength(POWERSHELL_PROGRAM, "utf8"),
    relativeHandleWalker: true,
    posixRenameByHandle: true,
    reparseRefusal: true,
    maximumEntryBytes: MAX_ENTRY_BYTES,
    maximumProtocolRequestBytes: MAX_PROTOCOL_REQUEST_BYTES,
    maximumProtocolResponseBytes: MAX_RESPONSE_BYTES,
    nativeFixedVolumeRootOnly: true,
    active: helperRunning,
  });
}

async function invokeFixedHelper(
  request: Readonly<Record<string, unknown>>,
  options: GovernedFileHandlePortOptions,
): Promise<unknown> {
  if (process.platform !== "win32") throw invalid("Windows handle mutation is unavailable on this platform");
  if (helperRunning) throw invalid("Windows handle mutation is already active");
  const deadlineMs = boundedInteger(options.deadlineMs ?? DEFAULT_DEADLINE_MS, 100, 120_000, "deadline");
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  if (requestBytes.byteLength > MAX_PROTOCOL_REQUEST_BYTES) throw invalid("request byte bound");
  const frame = Buffer.from(`${requestBytes.byteLength}\n${requestBytes.toString("base64")}\n`, "ascii");
  const executable = fixedPowerShellPath();
  helperRunning = true;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          POWERSHELL_ENCODED_BOOTSTRAP,
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            SystemRoot: "C:\\Windows",
            [PROGRAM_ENV_NAME]: POWERSHELL_PROGRAM_GZIP,
          },
        },
      );
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      let acceptingOutput = true;
      let pendingError: Error | undefined;
      const discardChunks = (): void => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
      };
      const onStdoutData = (chunk: Buffer): void => {
        if (!acceptingOutput) return;
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          stopAndPoison(invalid("response byte bound"));
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
        child.stdout.off("data", onStdoutData);
        child.kill();
      };
      const abort = (): void => {
        stopAndPoison(invalid("aborted"));
      };
      const timer = setTimeout(() => {
        stopAndPoison(invalid("deadline exceeded"));
      }, deadlineMs);
      timer.unref();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        stopAndPoison(invalid("helper could not start"));
      });
      child.stdin.once("error", () => {
        stopAndPoison(invalid("request could not be delivered"));
      });
      child.stdout.on("data", onStdoutData);
      child.once("close", (code) => {
        helperRunning = false;
        acceptingOutput = false;
        child.stdout.off("data", onStdoutData);
        if (settled) return;
        if (pendingError !== undefined) {
          finish(pendingError);
          return;
        }
        if (code !== 0) {
          discardChunks();
          finish(invalid("helper failed"));
          return;
        }
        const responseFrame = Buffer.concat(chunks);
        discardChunks();
        try {
          finish(undefined, decodeProtocolFrame(responseFrame));
        } catch {
          finish(invalid("response was invalid"));
        } finally {
          responseFrame.fill(0);
        }
      });
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      child.stdin.end(frame);
    });
  } finally {
    requestBytes.fill(0);
    frame.fill(0);
  }
}

function decodeProtocolFrame(frame: Buffer): unknown {
  if (frame.byteLength < 4 || frame.byteLength > MAX_RESPONSE_BYTES) throw invalid("response was invalid");
  const firstNewline = frame.indexOf(0x0a);
  const secondNewline = frame.indexOf(0x0a, firstNewline + 1);
  if (firstNewline < 1 || secondNewline !== frame.byteLength - 1) throw invalid("response was invalid");
  const lengthText = frame.subarray(0, firstNewline).toString("ascii");
  if (!/^(?:0|[1-9]\d{0,9})$/u.test(lengthText)) throw invalid("response was invalid");
  const expectedLength = Number(lengthText);
  const encoded = frame.subarray(firstNewline + 1, secondNewline).toString("ascii");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw invalid("response was invalid");
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (decoded.byteLength !== expectedLength || decoded.toString("base64") !== encoded) {
      throw invalid("response was invalid");
    }
    const text = decoded.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(decoded)) throw invalid("response was invalid");
    return JSON.parse(text) as unknown;
  } finally {
    decoded.fill(0);
  }
}

function throwForNonOkStatus(record: Record<string, unknown>): void {
  if (record.status === "ok") return;
  if (record.status === "refused") {
    const reason = record.reason;
    if (
      typeof reason === "string" &&
      (GOVERNED_FILE_HANDLE_PORT_REFUSAL_REASONS as readonly string[]).includes(reason)
    ) {
      throw new GovernedFileHandlePortRefusalError(reason as GovernedFileHandlePortRefusalReason);
    }
    throw invalid("refusal reason was invalid");
  }
  if (record.status === "uncertain") {
    const reason = record.reason;
    if (typeof reason === "string" && /^[a-z_]{1,64}$/u.test(reason)) {
      throw new GovernedFileHandlePortUncertainError(reason);
    }
    throw invalid("uncertain reason was invalid");
  }
  throw invalid("response status was invalid");
}

function statusEnvelope(value: unknown, operation: string, keys: readonly string[]): Record<string, unknown> {
  const bare = looseRecord(value);
  if (bare.status === "refused" || bare.status === "uncertain") {
    const record = exactRecord(value, ["schemaVersion", "operation", "status", "reason"]);
    if (record.schemaVersion !== SCHEMA_VERSION || record.operation !== operation) {
      throw invalid("response binding was invalid");
    }
    throwForNonOkStatus(record);
  }
  const record = exactRecord(value, ["schemaVersion", "operation", "status", ...keys]);
  if (record.schemaVersion !== SCHEMA_VERSION || record.operation !== operation || record.status !== "ok") {
    throw invalid("response binding was invalid");
  }
  return record;
}

function parseCaptureResponse(value: unknown, rootPath: string, relativePath: string): GovernedFileCaptureEvidence {
  const record = statusEnvelope(value, "capture", [
    "rootPath",
    "relativePath",
    "parentBefore",
    "parentAfter",
    "present",
    "entry",
    "contentBase64",
    "sha256",
  ]);
  if (record.rootPath !== rootPath || record.relativePath !== relativePath) {
    throw invalid("response binding was invalid");
  }
  const parentBefore = parseObservation(record.parentBefore);
  const parent = parseObservation(record.parentAfter);
  if (!sameIdentity(parentBefore, parent)) throw invalid("parent identity changed during capture");
  if (typeof record.present !== "boolean") throw invalid("presence flag was invalid");
  if (!record.present) {
    if (record.entry !== null || record.contentBase64 !== "" || record.sha256 !== "") {
      throw invalid("absent capture carried content");
    }
    return Object.freeze({
      rootPath,
      relativePath,
      parent,
      present: false,
      entry: null,
      content: null,
      sha256: null,
    });
  }
  const entry = parseObservation(record.entry);
  assertPlainRegularEntry(entry);
  if (typeof record.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.contentBase64)) {
    throw invalid("content encoding was invalid");
  }
  const content = Buffer.from(record.contentBase64, "base64");
  if (
    content.byteLength > MAX_ENTRY_BYTES ||
    content.toString("base64") !== record.contentBase64 ||
    content.byteLength !== entry.sizeBytes
  ) {
    content.fill(0);
    throw invalid("content byte bound");
  }
  const sha256 = canonicalHex(record.sha256, 64, "content SHA-256");
  if (sha256 !== sha256Of(content)) {
    content.fill(0);
    throw invalid("content hash mismatch");
  }
  return Object.freeze({
    rootPath,
    relativePath,
    parent,
    present: true,
    entry,
    content,
    sha256,
  });
}

function parsePublishResponse(
  value: unknown,
  rootPath: string,
  relativePath: string,
  expectedPrior: GovernedFileExpectedPrior,
): GovernedFilePublishEvidence {
  const record = statusEnvelope(value, "publish", [
    "rootPath",
    "relativePath",
    "parentBefore",
    "parentAfter",
    "priorPresent",
    "priorSha256",
    "published",
    "publishedSha256",
  ]);
  if (record.rootPath !== rootPath || record.relativePath !== relativePath) {
    throw invalid("response binding was invalid");
  }
  const parentBefore = parseObservation(record.parentBefore);
  const parent = parseObservation(record.parentAfter);
  if (!sameIdentity(parentBefore, parent)) throw invalid("parent identity changed during publish");
  if (record.priorPresent !== expectedPrior.present) throw invalid("prior presence binding was invalid");
  let priorSha256: string | null = null;
  if (expectedPrior.present) {
    priorSha256 = canonicalHex(record.priorSha256, 64, "prior content SHA-256");
    if (priorSha256 !== expectedPrior.sha256) throw invalid("prior hash binding was invalid");
  } else if (record.priorSha256 !== "") {
    throw invalid("prior hash binding was invalid");
  }
  const published = parseObservation(record.published);
  assertPlainRegularEntry(published);
  const publishedSha256 = canonicalHex(record.publishedSha256, 64, "published content SHA-256");
  return Object.freeze({
    rootPath,
    relativePath,
    parent,
    priorPresent: expectedPrior.present,
    priorSha256,
    published,
    publishedSha256,
    renameMechanism: "posix_handle_rename",
  });
}

function parseRemoveResponse(
  value: unknown,
  rootPath: string,
  relativePath: string,
  expectedSha256: string,
): GovernedFileRemoveEvidence {
  const record = statusEnvelope(value, "remove", [
    "rootPath",
    "relativePath",
    "parentBefore",
    "parentAfter",
    "priorSha256",
  ]);
  if (record.rootPath !== rootPath || record.relativePath !== relativePath) {
    throw invalid("response binding was invalid");
  }
  const parentBefore = parseObservation(record.parentBefore);
  const parent = parseObservation(record.parentAfter);
  if (!sameIdentity(parentBefore, parent)) throw invalid("parent identity changed during removal");
  const priorSha256 = canonicalHex(record.priorSha256, 64, "prior content SHA-256");
  if (priorSha256 !== expectedSha256) throw invalid("prior hash binding was invalid");
  return Object.freeze({ rootPath, relativePath, parent, priorSha256, removed: true });
}

function parseObservation(value: unknown): GovernedFileHandleObservation {
  const record = exactRecord(value, [
    "volumeSerial",
    "fileId",
    "sizeBytes",
    "linkCount",
    "attributes",
    "reparseTag",
    "lastWriteTime",
    "changeTime",
  ]);
  return Object.freeze({
    volumeSerial: canonicalHex(record.volumeSerial, 16, "volume serial"),
    fileId: canonicalHex(record.fileId, 32, "file ID"),
    // Parent directories may report large index sizes; entry content stays
    // bounded separately by the exact content byte checks.
    sizeBytes: boundedInteger(record.sizeBytes, 0, 512 * 1024 * 1024, "entry size"),
    linkCount: boundedInteger(record.linkCount, 1, 65_535, "link count"),
    attributes: boundedInteger(record.attributes, 0, 0xffff_ffff, "attributes"),
    reparseTag: boundedInteger(record.reparseTag, 0, 0xffff_ffff, "reparse tag"),
    lastWriteTime: canonicalFileTime(record.lastWriteTime),
    changeTime: canonicalFileTime(record.changeTime),
  });
}

function assertPlainRegularEntry(entry: GovernedFileHandleObservation): void {
  if (entry.reparseTag !== 0 || (entry.attributes & 0x400) !== 0) throw invalid("entry is a reparse point");
  if ((entry.attributes & 0x10) !== 0) throw invalid("entry is a directory");
  if (entry.linkCount !== 1) throw invalid("entry has additional hard links");
}

function sameIdentity(left: GovernedFileHandleObservation, right: GovernedFileHandleObservation): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function canonicalIdentity(value: GovernedFileHandleIdentity): GovernedFileHandleIdentity {
  return Object.freeze({
    volumeSerial: canonicalHex(value.volumeSerial, 16, "expected parent volume serial"),
    fileId: canonicalHex(value.fileId, 32, "expected parent file ID"),
  });
}

function canonicalExpectedPrior(value: GovernedFileExpectedPrior): GovernedFileExpectedPrior {
  if (value.present === true) {
    return Object.freeze({ present: true, sha256: canonicalHex(value.sha256, 64, "expected prior SHA-256") });
  }
  if (value.present === false) return Object.freeze({ present: false });
  throw invalid("expected prior state was invalid");
}

function canonicalLocalDrivePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 32_767 ||
    !/^[A-Z]:\\[^\0\r\n]*$/u.test(value) ||
    value.includes("/") ||
    value.startsWith("\\\\") ||
    value.startsWith("\\?\\") ||
    value.startsWith("\\.\\") ||
    value.slice(2).includes(":") ||
    path.normalize(value) !== value ||
    value.endsWith("\\")
  ) {
    throw invalid("root must be a canonical local-drive path");
  }
  for (const segment of value.slice(3).split("\\")) canonicalPathSegment(segment);
  return value;
}

function canonicalEntryRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    throw invalid("relative path was invalid");
  }
  const segments = value.split("/");
  for (const segment of segments) canonicalPathSegment(segment);
  return segments.join("/");
}

function canonicalPathSegment(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.normalize("NFC") !== value ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\p{Cc}]/u.test(value) ||
    /[ .]$/u.test(value) ||
    isWindowsReserved(value)
  ) {
    throw invalid("path segment was invalid");
  }
  return value;
}

function isWindowsReserved(value: string): boolean {
  const base = value.split(".", 1)[0]?.normalize("NFKC").toLocaleUpperCase("en-US");
  return base !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function canonicalHex(value: unknown, length: number, label: string): string {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/u.test(value)) {
    throw invalid(`${label} was invalid`);
  }
  return value;
}

function canonicalFileTime(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/u.test(value)) {
    throw invalid("file timestamp was invalid");
  }
  return value;
}

function looseRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("response must contain plain records");
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  const record = looseRecord(value);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("response must contain plain records");
  }
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    throw invalid("response must contain plain data fields");
  }
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid("response has missing or unknown fields");
  }
  return record;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${label} was invalid`);
  }
  return value as number;
}

function sha256Of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fixedPowerShellPath(): string {
  return path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function invalid(message: string): GovernedFileHandlePortError {
  return new GovernedFileHandlePortError(`Governed file handle port: ${message}.`);
}
