import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { win32 as path } from "node:path";
import { gzipSync } from "node:zlib";

const SCHEMA_VERSION = "goatcitadel.remote-worker-windows-no-follow.v1" as const;
const DEFAULT_DEADLINE_MS = 15_000;
const MAX_PROTOCOL_REQUEST_BYTES = 16 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_HASH_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CONTENT_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ENUMERATE_RESPONSE_BYTES = MAX_RESPONSE_BYTES;
const MAX_HASH_RESPONSE_BYTES = 1024 * 1024;
const READ_RESPONSE_METADATA_BYTES = 512 * 1024;
const PROGRAM_ENV_NAME = "GOATCITADEL_REMOTE_WORKER_NO_FOLLOW_PROGRAM";
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

export interface RemoteWorkerWindowsFileObservation {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly sizeBytes: number;
  readonly linkCount: number;
  readonly attributes: number;
  readonly reparseTag: number;
  readonly creationTime: string;
  readonly lastWriteTime: string;
  readonly changeTime: string;
  readonly ownerSid: string;
  readonly sddl: string;
  readonly streams: readonly string[];
}

export interface RemoteWorkerWindowsDirectoryEntry {
  readonly name: string;
  readonly kind: "directory" | "regular_file" | "reparse" | "special";
  readonly observation: RemoteWorkerWindowsFileObservation;
}

export interface RemoteWorkerWindowsDirectoryEvidence {
  readonly operatorSid: string;
  readonly rootPath: string;
  readonly relativeDirectory: string;
  readonly rootObservation: RemoteWorkerWindowsFileObservation;
  readonly directoryObservation: RemoteWorkerWindowsFileObservation;
  readonly firstNames: readonly string[];
  readonly secondNames: readonly string[];
  readonly entries: readonly RemoteWorkerWindowsDirectoryEntry[];
}

export interface RemoteWorkerWindowsFileEvidence {
  readonly operatorSid: string;
  readonly rootPath: string;
  readonly relativePath: string;
  readonly before: RemoteWorkerWindowsFileObservation;
  readonly after: RemoteWorkerWindowsFileObservation;
  readonly ancestorsBefore: readonly RemoteWorkerWindowsFileObservation[];
  readonly ancestorsAfter: readonly RemoteWorkerWindowsFileObservation[];
  readonly content: Buffer;
}

export interface RemoteWorkerWindowsFileHashEvidence {
  readonly operatorSid: string;
  readonly rootPath: string;
  readonly relativePath: string;
  readonly before: RemoteWorkerWindowsFileObservation;
  readonly after: RemoteWorkerWindowsFileObservation;
  readonly ancestorsBefore: readonly RemoteWorkerWindowsFileObservation[];
  readonly ancestorsAfter: readonly RemoteWorkerWindowsFileObservation[];
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface RemoteWorkerWindowsNoFollowOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
}

export class RemoteWorkerWindowsNoFollowError extends Error {
  readonly code = "REMOTE_WORKER_WINDOWS_NO_FOLLOW_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerWindowsNoFollowError";
  }
}

export async function enumerateRemoteWorkerWindowsDirectory(
  rootPath: string,
  relativeDirectory: string,
  options: RemoteWorkerWindowsNoFollowOptions = {},
): Promise<RemoteWorkerWindowsDirectoryEvidence> {
  const root = canonicalLocalDrivePath(rootPath);
  const relative = canonicalRelativePath(relativeDirectory, true);
  const raw = await invokeFixedHelper(
    Object.freeze({ schemaVersion: SCHEMA_VERSION, operation: "enumerate", rootPath: root, relativePath: relative }),
    withShorterResponseLimit(options, MAX_ENUMERATE_RESPONSE_BYTES),
  );
  return parseEnumerateResponse(raw, root, relative);
}

export async function readRemoteWorkerWindowsFile(
  rootPath: string,
  relativePath: string,
  maximumBytes: number,
  options: RemoteWorkerWindowsNoFollowOptions = {},
): Promise<RemoteWorkerWindowsFileEvidence> {
  const root = canonicalLocalDrivePath(rootPath);
  const relative = canonicalRelativePath(relativePath, false);
  const maxBytes = boundedInteger(maximumBytes, 1, MAX_CONTENT_FILE_BYTES, "content file byte limit");
  const raw = await invokeFixedHelper(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: "read_file",
      rootPath: root,
      relativePath: relative,
      maxBytes,
    }),
    withShorterResponseLimit(options, framedReadResponseLimit(maxBytes)),
  );
  return parseReadResponse(raw, root, relative, maxBytes);
}

export async function hashRemoteWorkerWindowsFile(
  rootPath: string,
  relativePath: string,
  maximumBytes: number,
  options: RemoteWorkerWindowsNoFollowOptions = {},
): Promise<RemoteWorkerWindowsFileHashEvidence> {
  const root = canonicalLocalDrivePath(rootPath);
  const relative = canonicalRelativePath(relativePath, false);
  const maxBytes = boundedInteger(maximumBytes, 1, MAX_HASH_FILE_BYTES, "hash file byte limit");
  const raw = await invokeFixedHelper(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: "hash_file",
      rootPath: root,
      relativePath: relative,
      maxBytes,
    }),
    withShorterResponseLimit(options, MAX_HASH_RESPONSE_BYTES),
  );
  return parseHashResponse(raw, root, relative, maxBytes);
}

/** Pure protocol validation for deterministic tests. It is not filesystem authority. */
export function validateRemoteWorkerWindowsNoFollowResponse(
  value: unknown,
  expected: {
    readonly operation: "enumerate" | "read_file" | "hash_file";
    readonly rootPath: string;
    readonly relativePath: string;
    readonly maxBytes?: number;
  },
): RemoteWorkerWindowsDirectoryEvidence | RemoteWorkerWindowsFileEvidence | RemoteWorkerWindowsFileHashEvidence {
  const root = canonicalLocalDrivePath(expected.rootPath);
  const relative = canonicalRelativePath(expected.relativePath, expected.operation === "enumerate");
  if (expected.operation === "enumerate") return parseEnumerateResponse(value, root, relative);
  if (expected.operation === "read_file") {
    return parseReadResponse(
      value,
      root,
      relative,
      boundedInteger(expected.maxBytes, 1, MAX_CONTENT_FILE_BYTES, "content file byte limit"),
    );
  }
  return parseHashResponse(
    value,
    root,
    relative,
    boundedInteger(expected.maxBytes, 1, MAX_HASH_FILE_BYTES, "hash file byte limit"),
  );
}

/** Secret-free diagnostics proving the helper command is fixed and non-PATH-resolved. */
export function remoteWorkerWindowsNoFollowHelperDiagnostics(): Readonly<{
  executableKind: "system32_windows_powershell";
  encodedProgramSha256InputBytes: number;
  relativeHandleWalker: true;
  maximumContentFileBytes: number;
  maximumHashFileBytes: number;
  maximumHashResponseBytes: number;
  maximumProtocolResponseBytes: number;
  nativeFixedVolumeRootOnly: true;
  active: boolean;
}> {
  return Object.freeze({
    executableKind: "system32_windows_powershell",
    encodedProgramSha256InputBytes: Buffer.byteLength(POWERSHELL_PROGRAM, "utf8"),
    relativeHandleWalker: true,
    maximumContentFileBytes: MAX_CONTENT_FILE_BYTES,
    maximumHashFileBytes: MAX_HASH_FILE_BYTES,
    maximumHashResponseBytes: MAX_HASH_RESPONSE_BYTES,
    maximumProtocolResponseBytes: MAX_RESPONSE_BYTES,
    nativeFixedVolumeRootOnly: true,
    active: helperRunning,
  });
}

async function invokeFixedHelper(
  request: Readonly<Record<string, unknown>>,
  options: RemoteWorkerWindowsNoFollowOptions,
): Promise<unknown> {
  if (process.platform !== "win32") throw invalid("Windows no-follow inspection is unavailable on this platform.");
  if (helperRunning) throw invalid("Windows no-follow inspection is already active.");
  const deadlineMs = boundedInteger(options.deadlineMs ?? DEFAULT_DEADLINE_MS, 100, 120_000, "deadline");
  const maximumResponseBytes = boundedInteger(
    options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    1_024,
    MAX_RESPONSE_BYTES,
    "response byte limit",
  );
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  if (requestBytes.byteLength > MAX_PROTOCOL_REQUEST_BYTES) throw invalid("Windows no-follow request is too large.");
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
        if (received > maximumResponseBytes) {
          stopAndPoison(invalid("Windows no-follow response exceeded its byte limit."));
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
        stopAndPoison(invalid("Windows no-follow inspection was aborted."));
      };
      const timer = setTimeout(() => {
        stopAndPoison(invalid("Windows no-follow inspection exceeded its deadline."));
      }, deadlineMs);
      timer.unref();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        stopAndPoison(invalid("Windows no-follow inspection could not start."));
      });
      child.stdin.once("error", () => {
        stopAndPoison(invalid("Windows no-follow request could not be delivered."));
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
          finish(invalid("Windows no-follow inspection failed."));
          return;
        }
        const responseFrame = Buffer.concat(chunks);
        discardChunks();
        try {
          finish(undefined, decodeProtocolFrame(responseFrame));
        } catch {
          finish(invalid("Windows no-follow response was invalid."));
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
  if (frame.byteLength < 4 || frame.byteLength > MAX_RESPONSE_BYTES)
    throw invalid("Windows no-follow response was invalid.");
  const firstNewline = frame.indexOf(0x0a);
  const secondNewline = frame.indexOf(0x0a, firstNewline + 1);
  if (firstNewline < 1 || secondNewline !== frame.byteLength - 1)
    throw invalid("Windows no-follow response was invalid.");
  const lengthText = frame.subarray(0, firstNewline).toString("ascii");
  if (!/^(?:0|[1-9]\d{0,9})$/u.test(lengthText)) throw invalid("Windows no-follow response was invalid.");
  const expectedLength = Number(lengthText);
  const encoded = frame.subarray(firstNewline + 1, secondNewline).toString("ascii");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw invalid("Windows no-follow response was invalid.");
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (decoded.byteLength !== expectedLength || decoded.toString("base64") !== encoded) {
      throw invalid("Windows no-follow response was invalid.");
    }
    const text = decoded.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(decoded)) throw invalid("Windows no-follow response was invalid.");
    return JSON.parse(text) as unknown;
  } finally {
    decoded.fill(0);
  }
}

function parseEnumerateResponse(
  value: unknown,
  rootPath: string,
  relativePath: string,
): RemoteWorkerWindowsDirectoryEvidence {
  const record = exactRecord(value, [
    "schemaVersion",
    "operation",
    "operatorSid",
    "rootPath",
    "relativePath",
    "rootBefore",
    "rootAfter",
    "directoryBefore",
    "directoryAfter",
    "firstNames",
    "secondNames",
    "entries",
  ]);
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    record.operation !== "enumerate" ||
    record.rootPath !== rootPath ||
    record.relativePath !== relativePath
  ) {
    throw invalid("Windows no-follow response binding is invalid.");
  }
  const rootBefore = parseObservation(record.rootBefore);
  const rootObservation = parseObservation(record.rootAfter);
  const directoryBefore = parseObservation(record.directoryBefore);
  const directoryObservation = parseObservation(record.directoryAfter);
  if (!sameObservation(rootBefore, rootObservation) || !sameObservation(directoryBefore, directoryObservation)) {
    throw invalid("Windows directory identity changed during inspection.");
  }
  const operatorSid = canonicalSid(record.operatorSid);
  if (rootObservation.ownerSid !== operatorSid) throw invalid("Windows no-follow root is not operator-owned.");
  const firstNames = parseNameList(record.firstNames);
  const secondNames = parseNameList(record.secondNames);
  if (!equalStringLists(firstNames, secondNames))
    throw invalid("Windows directory enumeration changed during inspection.");
  if (!Array.isArray(record.entries) || record.entries.length !== secondNames.length) {
    throw invalid("Windows directory evidence is incomplete.");
  }
  const entries = record.entries.map((entry) => parseDirectoryEntry(entry));
  const entryNames = entries.map((entry) => entry.name);
  if (!equalStringLists(entryNames, secondNames)) throw invalid("Windows directory evidence is inconsistent.");
  return Object.freeze({
    operatorSid,
    rootPath,
    relativeDirectory: relativePath,
    rootObservation,
    directoryObservation,
    firstNames: Object.freeze(firstNames),
    secondNames: Object.freeze(secondNames),
    entries: Object.freeze(entries),
  });
}

function parseReadResponse(
  value: unknown,
  rootPath: string,
  relativePath: string,
  maximumBytes: number,
): RemoteWorkerWindowsFileEvidence {
  const record = exactRecord(value, [
    "schemaVersion",
    "operation",
    "operatorSid",
    "rootPath",
    "relativePath",
    "before",
    "after",
    "ancestorsBefore",
    "ancestorsAfter",
    "contentBase64",
  ]);
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    record.operation !== "read_file" ||
    record.rootPath !== rootPath ||
    record.relativePath !== relativePath
  ) {
    throw invalid("Windows no-follow response binding is invalid.");
  }
  const before = parseObservation(record.before);
  const after = parseObservation(record.after);
  if (!sameObservation(before, after)) throw invalid("Windows file identity changed during inspection.");
  const ancestorsBefore = parseObservationList(record.ancestorsBefore);
  const ancestorsAfter = parseObservationList(record.ancestorsAfter);
  if (
    ancestorsBefore.length < 1 ||
    ancestorsBefore.length !== ancestorsAfter.length ||
    ancestorsBefore.some(
      (item, index) => !sameObservation(item, ancestorsAfter[index] as RemoteWorkerWindowsFileObservation),
    )
  ) {
    throw invalid("Windows file ancestry changed during inspection.");
  }
  const operatorSid = canonicalSid(record.operatorSid);
  if (ancestorsBefore[0]?.ownerSid !== operatorSid) throw invalid("Windows no-follow root is not operator-owned.");
  if (typeof record.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.contentBase64)) {
    throw invalid("Windows file content encoding is invalid.");
  }
  const content = Buffer.from(record.contentBase64, "base64");
  if (content.byteLength > maximumBytes || content.toString("base64") !== record.contentBase64) {
    content.fill(0);
    throw invalid("Windows file content exceeds its byte limit.");
  }
  if (before.sizeBytes !== content.byteLength || after.sizeBytes !== content.byteLength) {
    content.fill(0);
    throw invalid("Windows file content size changed during inspection.");
  }
  return Object.freeze({
    operatorSid,
    rootPath,
    relativePath,
    before,
    after,
    ancestorsBefore: Object.freeze(ancestorsBefore),
    ancestorsAfter: Object.freeze(ancestorsAfter),
    content,
  });
}

function parseHashResponse(
  value: unknown,
  rootPath: string,
  relativePath: string,
  maximumBytes: number,
): RemoteWorkerWindowsFileHashEvidence {
  const record = exactRecord(value, [
    "schemaVersion",
    "operation",
    "operatorSid",
    "rootPath",
    "relativePath",
    "before",
    "after",
    "ancestorsBefore",
    "ancestorsAfter",
    "sizeBytes",
    "sha256",
  ]);
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    record.operation !== "hash_file" ||
    record.rootPath !== rootPath ||
    record.relativePath !== relativePath
  ) {
    throw invalid("Windows no-follow hash response binding is invalid.");
  }
  const before = parseObservation(record.before);
  const after = parseObservation(record.after);
  if (!sameObservation(before, after)) throw invalid("Windows file identity changed during hashing.");
  const ancestorsBefore = parseObservationList(record.ancestorsBefore);
  const ancestorsAfter = parseObservationList(record.ancestorsAfter);
  if (
    ancestorsBefore.length < 1 ||
    ancestorsBefore.length !== ancestorsAfter.length ||
    ancestorsBefore.some(
      (item, index) => !sameObservation(item, ancestorsAfter[index] as RemoteWorkerWindowsFileObservation),
    )
  ) {
    throw invalid("Windows file ancestry changed during hashing.");
  }
  const operatorSid = canonicalSid(record.operatorSid);
  if (ancestorsBefore[0]?.ownerSid !== operatorSid) throw invalid("Windows no-follow root is not operator-owned.");
  const sizeBytes = boundedInteger(record.sizeBytes, 0, maximumBytes, "hashed file size");
  if (before.sizeBytes !== sizeBytes || after.sizeBytes !== sizeBytes) {
    throw invalid("Windows hashed file size changed during inspection.");
  }
  const sha256 = canonicalHex(record.sha256, 64, "file SHA-256");
  return Object.freeze({
    operatorSid,
    rootPath,
    relativePath,
    before,
    after,
    ancestorsBefore: Object.freeze(ancestorsBefore),
    ancestorsAfter: Object.freeze(ancestorsAfter),
    sizeBytes,
    sha256,
  });
}

function parseObservationList(value: unknown): RemoteWorkerWindowsFileObservation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw invalid("Windows file ancestry evidence is invalid.");
  }
  return value.map((item) => parseObservation(item));
}

function parseDirectoryEntry(value: unknown): RemoteWorkerWindowsDirectoryEntry {
  const record = exactRecord(value, ["name", "kind", "observation"]);
  const name = canonicalPathSegment(record.name);
  if (!new Set(["directory", "regular_file", "reparse", "special"]).has(record.kind as string)) {
    throw invalid("Windows directory entry kind is invalid.");
  }
  return Object.freeze({
    name,
    kind: record.kind as RemoteWorkerWindowsDirectoryEntry["kind"],
    observation: parseObservation(record.observation),
  });
}

function parseObservation(value: unknown): RemoteWorkerWindowsFileObservation {
  const record = exactRecord(value, [
    "volumeSerial",
    "fileId",
    "sizeBytes",
    "linkCount",
    "attributes",
    "reparseTag",
    "creationTime",
    "lastWriteTime",
    "changeTime",
    "ownerSid",
    "sddl",
    "streams",
  ]);
  const volumeSerial = canonicalHex(record.volumeSerial, 16, "volume serial");
  const fileId = canonicalHex(record.fileId, 32, "file ID");
  const sizeBytes = boundedInteger(record.sizeBytes, 0, MAX_HASH_FILE_BYTES, "file size");
  const linkCount = boundedInteger(record.linkCount, 1, 65_535, "link count");
  const attributes = boundedInteger(record.attributes, 0, 0xffff_ffff, "attributes");
  const reparseTag = boundedInteger(record.reparseTag, 0, 0xffff_ffff, "reparse tag");
  const creationTime = canonicalFileTime(record.creationTime);
  const lastWriteTime = canonicalFileTime(record.lastWriteTime);
  const changeTime = canonicalFileTime(record.changeTime);
  const ownerSid = canonicalSid(record.ownerSid);
  const sddl = canonicalSddl(record.sddl);
  const streams = parseStreams(record.streams);
  return Object.freeze({
    volumeSerial,
    fileId,
    sizeBytes,
    linkCount,
    attributes,
    reparseTag,
    creationTime,
    lastWriteTime,
    changeTime,
    ownerSid,
    sddl,
    streams: Object.freeze(streams),
  });
}

function parseNameList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_DIRECTORY_ENTRIES)
    throw invalid("Windows directory listing is invalid.");
  const names = value.map(canonicalPathSegment);
  if (!isRawUtf8SortedUnique(names)) throw invalid("Windows directory listing is not in canonical byte order.");
  return names;
}

function parseStreams(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw invalid("Windows file stream list is invalid.");
  const streams = value.map((stream) => {
    if (typeof stream !== "string" || stream.length < 1 || stream.length > 512 || /[\r\n\0]/u.test(stream)) {
      throw invalid("Windows file stream name is invalid.");
    }
    return stream;
  });
  if (!isRawUtf8SortedUnique(streams)) throw invalid("Windows file stream list is invalid.");
  return streams;
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
    throw invalid("Windows no-follow root must be a canonical local-drive path.");
  }
  for (const segment of value.slice(3).split("\\")) canonicalPathSegment(segment);
  return value;
}

function canonicalRelativePath(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > 4_096 || value.includes("\\") || value.startsWith("/")) {
    throw invalid("Windows no-follow relative path is invalid.");
  }
  if (value === "") {
    if (allowEmpty) return value;
    throw invalid("Windows no-follow relative path is invalid.");
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
    throw invalid("Windows no-follow path segment is invalid.");
  }
  return value;
}

function isWindowsReserved(value: string): boolean {
  const base = value.split(".", 1)[0]?.normalize("NFKC").toLocaleUpperCase("en-US");
  return base !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function canonicalHex(value: unknown, length: number, label: string): string {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/u.test(value)) {
    throw invalid(`Windows no-follow ${label} is invalid.`);
  }
  return value;
}

function canonicalFileTime(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/u.test(value)) {
    throw invalid("Windows no-follow file timestamp is invalid.");
  }
  return value;
}

function canonicalSid(value: unknown): string {
  if (typeof value !== "string" || value.length > 184 || !/^S-1-(?:\d+-)*\d+$/u.test(value)) {
    throw invalid("Windows no-follow owner SID is invalid.");
  }
  return value;
}

function canonicalSddl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384 || /[\r\n\0]/u.test(value)) {
    throw invalid("Windows no-follow security descriptor is invalid.");
  }
  return value;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Windows no-follow response must contain plain records.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("Windows no-follow response must contain plain records.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    throw invalid("Windows no-follow response must contain plain data fields.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid("Windows no-follow response has missing or unknown fields.");
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`Windows no-follow ${label} is invalid.`);
  }
  return value as number;
}

function withShorterResponseLimit(
  options: RemoteWorkerWindowsNoFollowOptions,
  operationMaximum: number,
): RemoteWorkerWindowsNoFollowOptions {
  const requested =
    options.maxResponseBytes === undefined
      ? operationMaximum
      : boundedInteger(options.maxResponseBytes, 1_024, MAX_RESPONSE_BYTES, "response byte limit");
  return Object.freeze({ ...options, maxResponseBytes: Math.min(requested, operationMaximum) });
}

function framedReadResponseLimit(maximumContentBytes: number): number {
  const contentBase64Bytes = base64EncodedLength(maximumContentBytes);
  const innerJsonBytes = contentBase64Bytes + READ_RESPONSE_METADATA_BYTES;
  const framedBytes = 12 + base64EncodedLength(innerJsonBytes);
  if (framedBytes > MAX_RESPONSE_BYTES) throw invalid("Windows no-follow content response bound is invalid.");
  return framedBytes;
}

function base64EncodedLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function isRawUtf8SortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    if (index === 0) return true;
    return Buffer.compare(Buffer.from(values[index - 1] as string, "utf8"), Buffer.from(value, "utf8")) < 0;
  });
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameObservation(left: RemoteWorkerWindowsFileObservation, right: RemoteWorkerWindowsFileObservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fixedPowerShellPath(): string {
  return path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function invalid(message: string): RemoteWorkerWindowsNoFollowError {
  return new RemoteWorkerWindowsNoFollowError(message);
}

function buildPowerShellProgram(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::ASCII
[Console]::OutputEncoding = [Text.Encoding]::ASCII
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class GoatWorkerNoFollow {
  const uint FILE_READ_DATA = 0x0001, FILE_LIST_DIRECTORY = 0x0001, FILE_READ_ATTRIBUTES = 0x0080;
  const uint READ_CONTROL = 0x00020000, SYNCHRONIZE = 0x00100000;
  const uint FILE_SHARE_READ = 0x00000001, FILE_OPEN = 1;
  const uint FILE_DIRECTORY_FILE = 0x00000001, FILE_NON_DIRECTORY_FILE = 0x00000040;
  const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_DONT_REPARSE = 0x00001000;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const int FileBasicInfo = 0, FileStandardInfo = 1, FileAttributeTagInfo = 9, FileIdInfo = 18;
  const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006), FileStreamInformation = 22;

  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_BASIC_INFO {
    public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; public uint FileAttributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_STANDARD_INFO {
    public long AllocationSize, EndOfFile; public uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
    [MarshalAs(UnmanagedType.U1)] public bool Directory;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_ATTRIBUTE_TAG_INFO { public uint FileAttributes, ReparseTag; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct FILE_ID_INFO {
    public ulong VolumeSerialNumber; [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] FileId;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr p, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint QueryDosDeviceW(string device, StringBuilder target, int maximumCharacters);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h, uint a, ref OBJECT_ATTRIBUTES o,
    out IO_STATUS_BLOCK i, IntPtr z, uint fa, uint share, uint disposition, uint options, IntPtr e, uint el);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(IntPtr h, IntPtr ev, IntPtr apc, IntPtr ctx,
    out IO_STATUS_BLOCK ios, IntPtr info, uint length, int cls, bool single, IntPtr name, bool restart);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(IntPtr h, out IO_STATUS_BLOCK ios,
    IntPtr info, uint length, int cls);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(
    SafeFileHandle h, int cls, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(
    SafeFileHandle h, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(
    SafeFileHandle h, long distance, out long newPointer, uint moveMethod);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, int objectType,
    uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr sd, uint revision, uint securityInfo, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);

  public sealed class Walk : IDisposable {
    public readonly string RootPath; public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>(); public readonly int RootIndex;
    public Walk(string root, string relative, bool finalDirectory) {
      RootPath = root;
      AssertNativeFixedVolume(root);
      string volume = @"\\?\" + root.Substring(0, 3);
      SafeFileHandle current = CreateFileW(volume, FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Handles.Add(current);
      var all = new List<string>(); all.AddRange(root.Substring(3).Split(new[]{'\\'}, StringSplitOptions.RemoveEmptyEntries)); RootIndex=all.Count;
      if (!String.IsNullOrEmpty(relative)) all.AddRange(relative.Split('/'));
      for (int index=0; index<all.Count; index++) {
        bool directory = index < all.Count - 1 || finalDirectory;
        current = OpenAt(current, all[index], directory); Handles.Add(current);
      }
    }
    public SafeFileHandle Final { get { return Handles[Handles.Count-1]; } }
    public SafeFileHandle Root { get { return Handles[RootIndex]; } }
    public void Dispose() { for (int i=Handles.Count-1;i>=0;i--) Handles[i].Dispose(); }
  }

  static void AssertNativeFixedVolume(string root) {
    string drive = root.Substring(0, 2), driveRoot = drive + @"\";
    if(GetDriveTypeW(driveRoot) != 3) throw new IOException("native fixed volume required");
    var target = new StringBuilder(1024);
    uint count = QueryDosDeviceW(drive, target, target.Capacity);
    if(count == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    string value = target.ToString();
    if(!System.Text.RegularExpressions.Regex.IsMatch(value, @"^\\Device\\HarddiskVolume[0-9]+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
      throw new IOException("native fixed volume required");
  }

  static SafeFileHandle OpenAt(SafeFileHandle parent, string name, bool directory) {
    IntPtr text = Marshal.StringToHGlobalUni(name), usPtr = IntPtr.Zero;
    try {
      UNICODE_STRING us = new UNICODE_STRING { Length=(ushort)(name.Length*2), MaximumLength=(ushort)(name.Length*2), Buffer=text };
      usPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING))); Marshal.StructureToPtr(us, usPtr, false);
      OBJECT_ATTRIBUTES oa = new OBJECT_ATTRIBUTES { Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory=parent.DangerousGetHandle(), ObjectName=usPtr, Attributes=OBJ_DONT_REPARSE };
      IO_STATUS_BLOCK ios; IntPtr raw; uint access=FILE_READ_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE|(directory?FILE_LIST_DIRECTORY:FILE_READ_DATA);
      uint opts=FILE_SYNCHRONOUS_IO_NONALERT|FILE_OPEN_REPARSE_POINT|(directory?FILE_DIRECTORY_FILE:FILE_NON_DIRECTORY_FILE);
      int status=NtCreateFile(out raw, access, ref oa, out ios, IntPtr.Zero, 0, FILE_SHARE_READ, FILE_OPEN, opts, IntPtr.Zero, 0);
      if (status < 0) throw new IOException("relative handle open failed");
      return new SafeFileHandle(raw, true);
    } finally { if(usPtr!=IntPtr.Zero) Marshal.FreeHGlobal(usPtr); Marshal.FreeHGlobal(text); }
  }

  static T Query<T>(SafeFileHandle h, int cls) where T:struct {
    int size=Marshal.SizeOf(typeof(T)); IntPtr p=Marshal.AllocHGlobal(size);
    try { if(!GetFileInformationByHandleEx(h, cls, p, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error()); return (T)Marshal.PtrToStructure(p, typeof(T)); }
    finally { Marshal.FreeHGlobal(p); }
  }
  static string Hex(byte[] b) { var s=new StringBuilder(b.Length*2); foreach(byte x in b)s.Append(x.ToString("x2")); return s.ToString(); }
  static string Sddl(SafeFileHandle h, out string ownerSid) {
    IntPtr owner,group,dacl,sacl,sd; uint rc=GetSecurityInfo(h.DangerousGetHandle(),1,0x00000005,out owner,out group,out dacl,out sacl,out sd);
    if(rc!=0) throw new Win32Exception((int)rc); IntPtr text=IntPtr.Zero; uint len;
    try {
      ownerSid = new System.Security.Principal.SecurityIdentifier(owner).Value;
      if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,0x00000005,out text,out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return Marshal.PtrToStringUni(text) ?? "";
    } finally { if(text!=IntPtr.Zero) LocalFree(text); if(sd!=IntPtr.Zero) LocalFree(sd); }
  }
  static List<string> Streams(SafeFileHandle h) {
    int cap=65536; IntPtr p=Marshal.AllocHGlobal(cap); var result=new List<string>();
    try { IO_STATUS_BLOCK ios; int status=NtQueryInformationFile(h.DangerousGetHandle(),out ios,p,(uint)cap,FileStreamInformation); if(status<0)throw new IOException("stream query failed");
      long used=(long)ios.Information.ToUInt64(); if(used==0)return result; if(used<24||used>cap)throw new IOException("stream query invalid");
      int offset=0; while(true){ if(offset+24>used)throw new IOException("stream query invalid");int next=Marshal.ReadInt32(p,offset), nameBytes=Marshal.ReadInt32(p,offset+4);if(nameBytes<0||offset+24+nameBytes>used||nameBytes%2!=0)throw new IOException("stream query invalid"); string n=Marshal.PtrToStringUni(IntPtr.Add(p,offset+24),nameBytes/2)??""; result.Add(n); if(next==0)break;if(next<24||offset+next>used)throw new IOException("stream query invalid");offset+=next; } result.Sort(StringComparer.Ordinal); return result;
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static Dictionary<string,object> Observe(SafeFileHandle h) {
    var b=Query<FILE_BASIC_INFO>(h,FileBasicInfo); var s=Query<FILE_STANDARD_INFO>(h,FileStandardInfo); var t=Query<FILE_ATTRIBUTE_TAG_INFO>(h,FileAttributeTagInfo); var id=Query<FILE_ID_INFO>(h,FileIdInfo);
    byte[] idBytes=id.FileId;
    string owner; string sddl=Sddl(h,out owner);
    return new Dictionary<string,object>{{"volumeSerial",id.VolumeSerialNumber.ToString("x16")},{"fileId",Hex(idBytes)},{"sizeBytes",s.EndOfFile},{"linkCount",s.NumberOfLinks},{"attributes",b.FileAttributes},{"reparseTag",t.ReparseTag},{"creationTime",b.CreationTime.ToString()},{"lastWriteTime",b.LastWriteTime.ToString()},{"changeTime",b.ChangeTime.ToString()},{"ownerSid",owner},{"sddl",sddl},{"streams",s.Directory?new List<string>():Streams(h)}};
  }
  public static List<string> Enumerate(SafeFileHandle h) {
    var names=new List<string>(); int cap=262144; IntPtr p=Marshal.AllocHGlobal(cap); bool restart=true;
    try { while(true){ IO_STATUS_BLOCK ios; int status=NtQueryDirectoryFile(h.DangerousGetHandle(),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out ios,p,(uint)cap,37,false,IntPtr.Zero,restart); restart=false; if(status==STATUS_NO_MORE_FILES)break; if(status<0)throw new IOException("directory query failed"); long used=(long)ios.Information.ToUInt64();if(used<104||used>cap)throw new IOException("directory query invalid"); int offset=0; while(true){if(offset+104>used)throw new IOException("directory query invalid");int next=Marshal.ReadInt32(p,offset), bytes=Marshal.ReadInt32(p,offset+60);if(bytes<0||bytes%2!=0||offset+104L+bytes>used)throw new IOException("directory query invalid");string n=Marshal.PtrToStringUni(IntPtr.Add(p,offset+104),bytes/2)??""; if(n!="."&&n!=".."){if(names.Count>=10000)throw new IOException("directory entry limit");names.Add(n);} if(next==0)break;if(next<104||next%8!=0||offset+(long)next>used)throw new IOException("directory query invalid");offset+=next; } } names.Sort((a,b)=>CompareUtf8(a,b)); return names;
    } finally { Marshal.FreeHGlobal(p); }
  }
  static int CompareUtf8(string a,string b){byte[] x=Encoding.UTF8.GetBytes(a),y=Encoding.UTF8.GetBytes(b);int n=Math.Min(x.Length,y.Length);for(int i=0;i<n;i++){int c=x[i].CompareTo(y[i]);if(c!=0)return c;}return x.Length.CompareTo(y.Length);}
  public static byte[] Read(SafeFileHandle h,int max){long position;if(!SetFilePointerEx(h,0,out position,0))throw new Win32Exception(Marshal.GetLastWin32Error());var output=new MemoryStream();byte[] buf=new byte[65536];try{while(true){uint n;if(!ReadFile(h,buf,(uint)buf.Length,out n,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());if(n==0)break;if(output.Length+n>max)throw new IOException("file too large");output.Write(buf,0,(int)n);}return output.ToArray();}finally{Array.Clear(buf,0,buf.Length);output.Dispose();}}
  public static string Hash(SafeFileHandle h,int max,out long size){long position;if(!SetFilePointerEx(h,0,out position,0))throw new Win32Exception(Marshal.GetLastWin32Error());byte[] buf=new byte[65536];size=0;using(var sha=SHA256.Create()){try{while(true){uint n;if(!ReadFile(h,buf,(uint)buf.Length,out n,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());if(n==0)break;if(size+n>max)throw new IOException("file too large");sha.TransformBlock(buf,0,(int)n,buf,0);size+=n;}sha.TransformFinalBlock(Array.Empty<byte>(),0,0);return Hex(sha.Hash);}finally{Array.Clear(buf,0,buf.Length);}}}
  public static string OperatorSid(){return System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;}
}
'@
Add-Type -TypeDefinition $source -Language CSharp
function Frame([object]$value) { $json=$value|ConvertTo-Json -Depth 20 -Compress; $bytes=[Text.Encoding]::UTF8.GetBytes($json); [Console]::Out.Write($bytes.Length.ToString()+[char]10+[Convert]::ToBase64String($bytes)+[char]10) }
try {
  $lengthLine=[Console]::In.ReadLine(); $encoded=[Console]::In.ReadLine(); if($null -eq $lengthLine -or $null -eq $encoded){throw 'frame'}
  $bytes=[Convert]::FromBase64String($encoded); if($bytes.Length -ne [int]$lengthLine -or $bytes.Length -gt 16384){throw 'frame'}
  $request=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
  if($request.schemaVersion -ne '${SCHEMA_VERSION}'){throw 'schema'}
  $finalDirectory=$request.operation -eq 'enumerate'
  $walk=[GoatWorkerNoFollow+Walk]::new([string]$request.rootPath,[string]$request.relativePath,$finalDirectory)
  try {
    if($request.operation -eq 'enumerate'){
      $rootBefore=[GoatWorkerNoFollow]::Observe($walk.Root);$directoryBefore=[GoatWorkerNoFollow]::Observe($walk.Final);$first=[GoatWorkerNoFollow]::Enumerate($walk.Final); $entries=@(); foreach($name in $first){$childPath=(@($request.relativePath,$name)|Where-Object{$_ -ne ''}) -join '/';$child=$null;try{try{$child=[GoatWorkerNoFollow+Walk]::new([string]$request.rootPath,$childPath,$true)}catch{$child=[GoatWorkerNoFollow+Walk]::new([string]$request.rootPath,$childPath,$false)};$o=[GoatWorkerNoFollow]::Observe($child.Final);$attrs=[uint32]$o.attributes;$kind=if(($attrs-band 0x400)-ne 0){'reparse'}elseif(($attrs-band 0x10)-ne 0){'directory'}else{'regular_file'};$entries+=@{name=$name;kind=$kind;observation=$o}}finally{if($null -ne $child){$child.Dispose()}}}
      $second=[GoatWorkerNoFollow]::Enumerate($walk.Final);$rootAfter=[GoatWorkerNoFollow]::Observe($walk.Root);$directoryAfter=[GoatWorkerNoFollow]::Observe($walk.Final);Frame @{schemaVersion='${SCHEMA_VERSION}';operation='enumerate';operatorSid=[GoatWorkerNoFollow]::OperatorSid();rootPath=$request.rootPath;relativePath=$request.relativePath;rootBefore=$rootBefore;rootAfter=$rootAfter;directoryBefore=$directoryBefore;directoryAfter=$directoryAfter;firstNames=$first;secondNames=$second;entries=$entries}
    } elseif($request.operation -eq 'read_file') {
      $ancestorsBefore=@();for($i=$walk.RootIndex;$i -lt $walk.Handles.Count-1;$i++){$ancestorsBefore+=,[GoatWorkerNoFollow]::Observe($walk.Handles[$i])};$before=[GoatWorkerNoFollow]::Observe($walk.Final);$content=[GoatWorkerNoFollow]::Read($walk.Final,[int]$request.maxBytes);try{$after=[GoatWorkerNoFollow]::Observe($walk.Final);$ancestorsAfter=@();for($i=$walk.RootIndex;$i -lt $walk.Handles.Count-1;$i++){$ancestorsAfter+=,[GoatWorkerNoFollow]::Observe($walk.Handles[$i])};Frame @{schemaVersion='${SCHEMA_VERSION}';operation='read_file';operatorSid=[GoatWorkerNoFollow]::OperatorSid();rootPath=$request.rootPath;relativePath=$request.relativePath;ancestorsBefore=$ancestorsBefore;ancestorsAfter=$ancestorsAfter;before=$before;after=$after;contentBase64=[Convert]::ToBase64String($content)}}finally{[Array]::Clear($content,0,$content.Length)}
    } elseif($request.operation -eq 'hash_file') {
      $ancestorsBefore=@();for($i=$walk.RootIndex;$i -lt $walk.Handles.Count-1;$i++){$ancestorsBefore+=,[GoatWorkerNoFollow]::Observe($walk.Handles[$i])};$before=[GoatWorkerNoFollow]::Observe($walk.Final);[long]$size=0;$hash=[GoatWorkerNoFollow]::Hash($walk.Final,[int]$request.maxBytes,[ref]$size);$after=[GoatWorkerNoFollow]::Observe($walk.Final);$ancestorsAfter=@();for($i=$walk.RootIndex;$i -lt $walk.Handles.Count-1;$i++){$ancestorsAfter+=,[GoatWorkerNoFollow]::Observe($walk.Handles[$i])};Frame @{schemaVersion='${SCHEMA_VERSION}';operation='hash_file';operatorSid=[GoatWorkerNoFollow]::OperatorSid();rootPath=$request.rootPath;relativePath=$request.relativePath;ancestorsBefore=$ancestorsBefore;ancestorsAfter=$ancestorsAfter;before=$before;after=$after;sizeBytes=$size;sha256=$hash}
    } else { throw 'operation' }
  } finally { $walk.Dispose() }
} catch { exit 73 }
`;
}
