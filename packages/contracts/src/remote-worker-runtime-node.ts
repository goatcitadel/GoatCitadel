import path from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJsonString } from "./canonical-json.js";
import { normalizeRemoteWorkerRuntimeBundleManifest, remoteWorkerRuntimeBundleManifestSha256,
  type RemoteWorkerRuntimeBundleManifest } from "./remote-worker-runtime-bundle.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import { normalizeRemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileStaging } from "./remote-worker-native-file-staging.js";

// Node-only protocol ownership shared by Gateway admission and the worker.
// Encoding is never execution authorization; do not expose this as a worker
// approval endpoint or persist its command/environment in result expectations.
const rejectedRuntime = (): Error => new Error("Native Windows runtime request is invalid.");

/** Inspect descriptors before serialization so caller code, proxies and cycles cannot run at this boundary. */
function snapshotRuntimeValue<T>(value: T, maxBytes: number, freeze = false): T {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new Set<object>();
  const walk = (current: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw rejectedRuntime();
    if (typeof current === "string") {
      textBytes += Buffer.byteLength(current, "utf8");
      if (textBytes > maxBytes) throw rejectedRuntime();
      return;
    }
    if (current === null || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) return;
    if (!current || typeof current !== "object" || types.isProxy(current) || ancestors.has(current)) throw rejectedRuntime();
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype :
      ![Object.prototype, null].includes(Object.getPrototypeOf(current) as object | null)) throw rejectedRuntime();
    const fields = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(current).some((key) => typeof key !== "string")) throw rejectedRuntime();
    ancestors.add(current);
    for (const [key, descriptor] of Object.entries(fields)) {
      if (array && key === "length") continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length))) throw rejectedRuntime();
      textBytes += Buffer.byteLength(key, "utf8");
      if (textBytes > maxBytes) throw rejectedRuntime();
      walk(descriptor.value, depth + 1);
    }
    if (array && Object.keys(fields).length !== current.length + 1) throw rejectedRuntime();
    ancestors.delete(current);
  };
  walk(value, 0);
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw rejectedRuntime();
  const copy = JSON.parse(encoded) as T;
  const freezeDeep = (current: unknown): void => {
    if (current && typeof current === "object") {
      for (const item of Object.values(current)) freezeDeep(item);
      Object.freeze(current);
    }
  };
  if (freeze) freezeDeep(copy);
  return copy;
}

function runtimeRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw rejectedRuntime();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !optional.includes(key) && !Object.hasOwn(record, key)))
    throw rejectedRuntime();
  return record;
}

export interface WindowsWorkerStdioWorkspace {
  readonly parentPath: string;
  readonly parentIdentity: string;
  readonly rootIdentity: string;
  readonly controlIdentity: string;
  readonly runtimeIdentity: string;
  readonly workIdentity: string;
  readonly ownerSid: string;
  readonly controllerSid: string;
}
export function normalizeWindowsWorkerStdioWorkspace(value: unknown): WindowsWorkerStdioWorkspace {
  const workspace = runtimeRecord(snapshotRuntimeValue(value, 32 * 1024, true), ["parentPath", "parentIdentity", "rootIdentity",
    "controlIdentity", "runtimeIdentity", "workIdentity", "ownerSid", "controllerSid"]);
  const parent = workspace.parentPath;
  if (typeof parent !== "string" || !parent || parent.includes("\0") || Buffer.byteLength(parent, "utf8") > 16384 ||
    Buffer.from(parent, "utf8").toString("utf8") !== parent || !path.win32.isAbsolute(parent)) throw rejectedRuntime();
  const principal = (value: unknown, controller: boolean) => typeof value === "string" && value.length <= 184 &&
    (/^S-1-5-(18|21-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9}))$/u.test(value) ||
      (controller && /^S-1-5-80(?:-(?:0|[1-9][0-9]{0,9})){5}$/u.test(value)));
  if (!principal(workspace.ownerSid, false) || !principal(workspace.controllerSid, true)) throw rejectedRuntime();
  const identities = [workspace.parentIdentity, workspace.rootIdentity, workspace.controlIdentity, workspace.runtimeIdentity, workspace.workIdentity];
  for (const identity of identities) {
    if (typeof identity !== "string" || !/^[a-f0-9]{48}$/u.test(identity) || /^0{16}/u.test(identity) || /0{32}$/u.test(identity) ||
      identity.slice(0, 16) !== (workspace.parentIdentity as string).slice(0, 16)) throw rejectedRuntime();
  }
  if (new Set(identities).size !== identities.length) throw rejectedRuntime();
  return workspace as unknown as WindowsWorkerStdioWorkspace;
}
export interface WindowsWorkerStdioLaunch {
  readonly jobName: string;
  readonly appContainerName: string;
  readonly image: string;
  readonly commandLine: string;
  readonly directory: string;
  readonly runtimeRoot: string;
  readonly imageSha256: string;
  readonly directoryIdentity: string;
  readonly runtimeRootIdentity: string;
  readonly runtimeBundleSha256: string;
  readonly runtimeBundle: RemoteWorkerRuntimeBundleManifest;
  readonly environment: Readonly<Record<string, string>>;
  readonly protectedWorkspace?: WindowsWorkerStdioWorkspace;
  readonly limits: {
    readonly processLimit: number;
    readonly memoryBytes: number;
    readonly cpuMilli: number;
    readonly wallMs: number;
    readonly rawOutputBytes: number;
    readonly diagnosticBytes: number;
    readonly inputBytes: number;
  };
}
// The local stdio helper retains its 25-second ceiling. A separate trusted
// dispatch encoder may select the native job ceiling; JSON cannot select it.
export function normalizeWindowsWorkerStdioLaunch(value: unknown, maximumWallMs = 25000): WindowsWorkerStdioLaunch {
  if (!Number.isSafeInteger(maximumWallMs) || maximumWallMs < 1 || maximumWallMs > 86_400_000) throw rejectedRuntime();
  const input = runtimeRecord(snapshotRuntimeValue(value, 512 * 1024, true), ["jobName", "appContainerName", "image",
    "commandLine", "directory", "runtimeRoot", "imageSha256", "directoryIdentity", "runtimeRootIdentity", "runtimeBundleSha256",
    "runtimeBundle", "environment", "limits", "protectedWorkspace"], ["protectedWorkspace"]);
  const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum && Buffer.from(value, "utf8").toString("utf8") === value;
  if (!text(input.jobName, 40) || !/^gc-cell-[a-f0-9]{32}$/u.test(input.jobName) ||
    input.appContainerName !== `GoatCitadel.Worker.${input.jobName.slice(8)}` || !text(input.commandLine, 32766)) throw rejectedRuntime();
  for (const value of [input.image, input.directory, input.runtimeRoot])
    if (!text(value, 16384) || !path.win32.isAbsolute(value)) throw rejectedRuntime();
  for (const key of ["imageSha256", "runtimeBundleSha256", "directoryIdentity", "runtimeRootIdentity"]) {
    const value = input[key];
    const length = key.endsWith("Identity") ? 48 : 64;
    if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value) || /^0+$/u.test(value)) throw rejectedRuntime();
  }
  if (input.protectedWorkspace !== undefined) {
    const workspace = normalizeWindowsWorkerStdioWorkspace(input.protectedWorkspace);
    if (workspace.runtimeIdentity !== input.runtimeRootIdentity ||
      workspace.workIdentity !== input.directoryIdentity) throw rejectedRuntime();
  }
  const bundle = normalizeRemoteWorkerRuntimeBundleManifest(input.runtimeBundle);
  if (remoteWorkerRuntimeBundleManifestSha256(bundle) !== input.runtimeBundleSha256) throw rejectedRuntime();
  const image = path.win32.relative(input.runtimeRoot as string, input.image as string).replaceAll("\\", "/");
  if (!bundle.files.some((file) => file.relativePath === image && file.sha256 === input.imageSha256)) throw rejectedRuntime();
  const limits = runtimeRecord(input.limits, ["processLimit", "memoryBytes", "cpuMilli", "wallMs", "rawOutputBytes", "diagnosticBytes", "inputBytes"]);
  for (const [key, minimum, maximum] of [["processLimit", 1, 4096], ["memoryBytes", 1, Number.MAX_SAFE_INTEGER],
    ["cpuMilli", 1, 0xffffffff], ["wallMs", 1, maximumWallMs], ["rawOutputBytes", 1, 64 * 1024 * 1024],
    ["diagnosticBytes", 0, 65536], ["inputBytes", 0, 1024 * 1024]] as const) {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw rejectedRuntime();
  }
  if ((limits.diagnosticBytes as number) > (limits.rawOutputBytes as number)) throw rejectedRuntime();
  if (!input.environment || typeof input.environment !== "object" || Array.isArray(input.environment)) throw rejectedRuntime();
  const environment = Object.entries(input.environment);
  const names = new Set<string>();
  let characters = 1;
  for (const [name, value] of environment) {
    if (!/^[a-zA-Z0-9_]+$/u.test(name) || names.has(name.toLowerCase()) || typeof value !== "string" || value.includes("\0") ||
      !text(`${name}=${value}`, 8192)) throw rejectedRuntime();
    names.add(name.toLowerCase()); characters += name.length + 1 + value.length + 1;
  }
  if (environment.length > 64 || characters > 32767) throw rejectedRuntime();
  return input as unknown as WindowsWorkerStdioLaunch;
}

/** Encode a copied request before an asynchronous authority check or launch.
 * The returned Buffer is mutable; runtime dispatch must rebind before transport. */
export function encodeWindowsWorkerStdioLaunch(value: unknown, maximumWallMs = 25000): Buffer {
  const input = normalizeWindowsWorkerStdioLaunch(value, maximumWallMs);
  const chunks: Buffer[] = [];
  const integer = (value: number, bytes = 4) => {
    const buffer = Buffer.alloc(bytes);
    if (bytes === 8) buffer.writeBigUInt64LE(BigInt(value)); else buffer.writeUInt32LE(value);
    chunks.push(buffer);
  };
  const text = (value: string) => { const bytes = Buffer.from(value, "utf8"); integer(bytes.length); chunks.push(bytes); };
  for (const value of [input.jobName, input.appContainerName, input.image, input.commandLine, input.directory, input.runtimeRoot]) text(value);
  for (const value of [input.imageSha256, input.directoryIdentity, input.runtimeRootIdentity, input.runtimeBundleSha256]) chunks.push(Buffer.from(value, "hex"));
  const limits = input.limits;
  integer(limits.processLimit); integer(limits.memoryBytes, 8); integer(limits.cpuMilli); integer(limits.wallMs);
  integer(limits.rawOutputBytes, 8); integer(limits.diagnosticBytes); integer(limits.inputBytes);
  const environment = Object.entries(input.environment);
  integer(environment.length);
  for (const [name, value] of environment) text(`${name}=${value}`);
  integer(input.runtimeBundle.files.length);
  for (const file of input.runtimeBundle.files) { text(file.relativePath); integer(file.bytes, 8); chunks.push(Buffer.from(file.sha256, "hex")); }
  if (input.protectedWorkspace) {
    const workspace = input.protectedWorkspace;
    for (const value of [workspace.parentPath, workspace.ownerSid, workspace.controllerSid]) text(value);
    for (const value of [workspace.parentIdentity, workspace.rootIdentity, workspace.controlIdentity, workspace.runtimeIdentity, workspace.workIdentity])
      chunks.push(Buffer.from(value, "hex"));
  }
  const body = Buffer.concat(chunks);
  if (body.length > 512 * 1024) throw rejectedRuntime();
  const header = Buffer.alloc(12); header.write(input.protectedWorkspace ? "GCSTDIO2" : "GCSTDIO1", "ascii"); header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}

const domain = Buffer.from("goatcitadel.worker-runtime-dispatch.v1\0", "ascii");
export const WINDOWS_RUNTIME_DISPATCH_MAX_BYTES = 144 + 12 + 512 * 1024;
export interface WindowsRuntimeDispatchBinding {
  readonly nonce: string;
  readonly requestSha256: string;
}
export interface WindowsRuntimeDispatchRequest {
  readonly nonce: string;
  readonly anchor: { readonly fileIdentity: string; readonly preparedSha256: string };
  readonly checkpointSha256: string;
  readonly inventoryLimits: { readonly maxEntries: number; readonly maxDepth: number; readonly wallMs: number };
  readonly launch: WindowsWorkerStdioLaunch;
  readonly fileStaging?: RemoteWorkerNativeFileStaging;
}
export function normalizeWindowsRuntimeInventoryLimits(value: unknown): WindowsRuntimeDispatchRequest["inventoryLimits"] {
  const limits = runtimeRecord(snapshotRuntimeValue(value, 256, true), ["maxEntries", "maxDepth", "wallMs"]);
  for (const [key, minimum, maximum] of [["maxEntries", 1, 20000], ["maxDepth", 0, 64], ["wallMs", 1, 60000]] as const) {
    const number = limits[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw rejectedRuntime();
  }
  return limits as unknown as WindowsRuntimeDispatchRequest["inventoryLimits"];
}
/** Copy and validate the complete request before inspecting canonical bindings.
 * Normalization grants no approval, filesystem custody or execution authority. */
export function normalizeWindowsRuntimeDispatch(value: unknown): WindowsRuntimeDispatchRequest {
  const input = runtimeRecord(snapshotRuntimeValue(value, 600 * 1024, true), ["nonce", "anchor", "checkpointSha256", "inventoryLimits", "launch", "fileStaging"], ["fileStaging"]);
  const hex = (value: unknown, size: number): value is string => typeof value === "string" &&
    value.length === size * 2 && /^[a-f0-9]+$/u.test(value) && !/^0+$/u.test(value);
  if (!hex(input.nonce, 32) || !hex(input.checkpointSha256, 32)) throw rejectedRuntime();
  const anchor = runtimeRecord(input.anchor, ["fileIdentity", "preparedSha256"]);
  if (!hex(anchor.fileIdentity, 24) || !hex(anchor.preparedSha256, 32) ||
      /^0+$/u.test(anchor.fileIdentity.slice(0, 16)) || /^0+$/u.test(anchor.fileIdentity.slice(16))) throw rejectedRuntime();
  const inventoryLimits = normalizeWindowsRuntimeInventoryLimits(input.inventoryLimits);
  const launch = normalizeWindowsWorkerStdioLaunch(input.launch, 86_400_000);
  if (!launch.protectedWorkspace) throw rejectedRuntime();
  return Object.freeze({ ...input, inventoryLimits, launch,
    ...(input.fileStaging === undefined ? {} : { fileStaging: normalizeRemoteWorkerNativeFileStaging(input.fileStaging) }) }) as unknown as WindowsRuntimeDispatchRequest;
}

function encodeFileStaging(plan: RemoteWorkerNativeFileStaging): Buffer {
  const header = Buffer.alloc(20); header.write("GCFPLAN1", "ascii");
  header.writeUInt32LE(plan.paths.length, 8); header.writeUInt32LE(plan.maximumFileBytes, 12); header.writeUInt32LE(plan.maximumTotalBytes, 16);
  return Buffer.concat([header, ...plan.paths.flatMap(path => {
    const bytes = Buffer.from(path, "utf8"), size = Buffer.alloc(4); size.writeUInt32LE(bytes.length);
    return [size, bytes];
  })]);
}
function decodeFileStaging(bytes: Buffer): RemoteWorkerNativeFileStaging {
  if (bytes.length < 25 || bytes.length > 20 + 64 * 516 || bytes.subarray(0, 8).toString("ascii") !== "GCFPLAN1") throw rejectedRuntime();
  const count = bytes.readUInt32LE(8), paths: string[] = [];
  if (!count || count > 64) throw rejectedRuntime();
  let offset = 20;
  for (let index = 0; index < count; ++index) {
    if (offset + 4 > bytes.length) throw rejectedRuntime();
    const length = bytes.readUInt32LE(offset); offset += 4;
    if (!length || length > 512 || offset + length > bytes.length) throw rejectedRuntime();
    paths.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length))); offset += length;
  }
  if (offset !== bytes.length) throw rejectedRuntime();
  return normalizeRemoteWorkerNativeFileStaging({ paths, maximumFileBytes: bytes.readUInt32LE(12), maximumTotalBytes: bytes.readUInt32LE(16) });
}

/** Encode exact bytes; the controller receives the expected nonce and digest
 * independently from its trusted owner. Computing a digest grants no authority. */
export function encodeWindowsRuntimeDispatch(value: unknown): { readonly bytes: Buffer; readonly binding: WindowsRuntimeDispatchBinding } {
  const input = normalizeWindowsRuntimeDispatch(value), { anchor, inventoryLimits: limits } = input;
  const configuration = encodeWindowsWorkerStdioLaunch(input.launch, 86_400_000);
  const header = Buffer.alloc(144);
  header.write(input.fileStaging ? "GCRUN002" : "GCRUN001", "ascii"); Buffer.from(input.nonce, "hex").copy(header, 8);
  Buffer.from(anchor.fileIdentity, "hex").copy(header, 40); Buffer.from(anchor.preparedSha256, "hex").copy(header, 64);
  Buffer.from(input.checkpointSha256, "hex").copy(header, 96);
  header.writeUInt32LE(limits.maxEntries as number, 128); header.writeUInt32LE(limits.maxDepth as number, 132);
  header.writeUInt32LE(limits.wallMs as number, 136); header.writeUInt32LE(configuration.length, 140);
  const bytes = Buffer.concat([header, configuration, ...(input.fileStaging ? [encodeFileStaging(input.fileStaging)] : [])]);
  if (bytes.length > WINDOWS_RUNTIME_DISPATCH_MAX_BYTES) throw rejectedRuntime();
  return { bytes, binding: Object.freeze({ nonce: input.nonce, requestSha256: createHash("sha256").update(domain).update(bytes).digest("hex") }) };
}

/** Check the independently retained binding again immediately before transport.
 * Returns a new buffer so later mutation of the caller's bytes cannot substitute
 * a command after this check. This is not a substitute for current authority. */
export function bindWindowsRuntimeDispatch(value: Uint8Array, supplied: WindowsRuntimeDispatchBinding): Buffer {
  const binding = runtimeRecord(snapshotRuntimeValue(supplied, 512, true), ["nonce", "requestSha256"]);
  if (!(value instanceof Uint8Array) || value.byteLength <= 156 || value.byteLength > WINDOWS_RUNTIME_DISPATCH_MAX_BYTES ||
      typeof binding.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(binding.nonce) || /^0+$/u.test(binding.nonce) ||
      typeof binding.requestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binding.requestSha256) || /^0+$/u.test(binding.requestSha256)) throw rejectedRuntime();
  const bytes = Buffer.from(value);
  const version = bytes.subarray(0, 8).toString("ascii"), configurationEnd = 144 + bytes.readUInt32LE(140);
  if (!["GCRUN001", "GCRUN002"].includes(version) || bytes.subarray(8, 40).toString("hex") !== binding.nonce ||
      configurationEnd <= 156 || configurationEnd > bytes.length || bytes.subarray(144, 152).toString("ascii") !== "GCSTDIO2" ||
      bytes.readUInt32LE(152) !== configurationEnd - 156 ||
      createHash("sha256").update(domain).update(bytes).digest("hex") !== binding.requestSha256) throw rejectedRuntime();
  if (version === "GCRUN001" ? configurationEnd !== bytes.length : !encodeFileStaging(decodeFileStaging(bytes.subarray(configurationEnd))).equals(bytes.subarray(configurationEnd))) throw rejectedRuntime();
  return bytes;
}

/** Derive the immutable result expectation from the same copied request that
 * generated the bytes. This still requires canonical approval before storage
 * or dispatch. Rebind the bytes after every asynchronous ownership boundary. */
export function prepareWindowsRuntimeDispatch(value: unknown): {
  readonly bytes: Buffer;
  readonly binding: WindowsRuntimeDispatchBinding;
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
} {
  const input = snapshotRuntimeValue(value, 600 * 1024, true);
  const result = encodeWindowsRuntimeDispatch(input);
  const request = input as { checkpointSha256: string; inventoryLimits: { maxEntries: number }; launch: unknown };
  const launch = normalizeWindowsWorkerStdioLaunch(request.launch, 86_400_000);
  const expectation = normalizeRemoteWorkerRuntimeResultExpectation({ ...result.binding,
    checkpointSha256: request.checkpointSha256, runtimeBundleSha256: launch.runtimeBundleSha256,
    maxInputBytes: launch.limits.inputBytes, maxOutputBytes: launch.limits.rawOutputBytes,
    maxInventoryEntries: request.inventoryLimits.maxEntries });
  return Object.freeze({ ...result, expectation });
}
