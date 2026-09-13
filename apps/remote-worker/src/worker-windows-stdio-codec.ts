import path from "node:path";
import { normalizeRemoteWorkerRuntimeBundleManifest, remoteWorkerRuntimeBundleManifestSha256,
  type RemoteWorkerRuntimeBundleManifest } from "@goatcitadel/contracts";
import { snapshotWorkerMeshValue, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";

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
  const workspace = workerMeshRecord(snapshotWorkerMeshValue(value, 32 * 1024, true), ["parentPath", "parentIdentity", "rootIdentity",
    "controlIdentity", "runtimeIdentity", "workIdentity", "ownerSid", "controllerSid"]);
  const parent = workspace.parentPath;
  if (typeof parent !== "string" || !parent || parent.includes("\0") || Buffer.byteLength(parent, "utf8") > 16384 ||
    Buffer.from(parent, "utf8").toString("utf8") !== parent || !path.win32.isAbsolute(parent)) throw workerMeshRejected();
  const principal = (value: unknown, controller: boolean) => typeof value === "string" && value.length <= 184 &&
    (/^S-1-5-(18|21-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9}))$/u.test(value) ||
      (controller && /^S-1-5-80(?:-(?:0|[1-9][0-9]{0,9})){5}$/u.test(value)));
  if (!principal(workspace.ownerSid, false) || !principal(workspace.controllerSid, true)) throw workerMeshRejected();
  const identities = [workspace.parentIdentity, workspace.rootIdentity, workspace.controlIdentity, workspace.runtimeIdentity, workspace.workIdentity];
  for (const identity of identities) {
    if (typeof identity !== "string" || !/^[a-f0-9]{48}$/u.test(identity) || /^0{16}/u.test(identity) || /0{32}$/u.test(identity) ||
      identity.slice(0, 16) !== (workspace.parentIdentity as string).slice(0, 16)) throw workerMeshRejected();
  }
  if (new Set(identities).size !== identities.length) throw workerMeshRejected();
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
export interface WindowsWorkerStdioCompletion {
  readonly schemaVersion: "goatcitadel.worker-native-stdio.v1";
  readonly bridgeError: number;
  readonly end: number;
  readonly error: number;
  readonly processExitCode: number;
  readonly processId: number;
  readonly runtimeBundleVerified: boolean;
  readonly runtimeBundleSha256: string;
  readonly zeroProcessesVerified: boolean;
  readonly outputDrained: boolean;
  readonly appContainerVerified: boolean;
  readonly launchFilesVerified: boolean;
  readonly processImageVerified: boolean;
  readonly protectedWorkspaceVerified: boolean;
  readonly standardInputBytesWritten: number;
  readonly standardInputComplete: boolean;
  readonly standardOutputBytes: number;
  readonly standardErrorBytes: number;
}
export function normalizeWindowsWorkerStdioLaunch(value: unknown): WindowsWorkerStdioLaunch {
  const input = workerMeshRecord(snapshotWorkerMeshValue(value, 512 * 1024, true), ["jobName", "appContainerName", "image",
    "commandLine", "directory", "runtimeRoot", "imageSha256", "directoryIdentity", "runtimeRootIdentity", "runtimeBundleSha256",
    "runtimeBundle", "environment", "limits", "protectedWorkspace"], ["protectedWorkspace"]);
  const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum && Buffer.from(value, "utf8").toString("utf8") === value;
  if (!text(input.jobName, 40) || !/^gc-cell-[a-f0-9]{32}$/u.test(input.jobName) ||
    input.appContainerName !== `GoatCitadel.Worker.${input.jobName.slice(8)}` || !text(input.commandLine, 32766)) throw workerMeshRejected();
  for (const value of [input.image, input.directory, input.runtimeRoot])
    if (!text(value, 16384) || !path.win32.isAbsolute(value)) throw workerMeshRejected();
  for (const key of ["imageSha256", "runtimeBundleSha256", "directoryIdentity", "runtimeRootIdentity"]) {
    const value = input[key];
    const length = key.endsWith("Identity") ? 48 : 64;
    if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value) || /^0+$/u.test(value)) throw workerMeshRejected();
  }
  if (input.protectedWorkspace !== undefined) {
    const workspace = normalizeWindowsWorkerStdioWorkspace(input.protectedWorkspace);
    if (workspace.runtimeIdentity !== input.runtimeRootIdentity ||
      workspace.workIdentity !== input.directoryIdentity) throw workerMeshRejected();
  }
  const bundle = normalizeRemoteWorkerRuntimeBundleManifest(input.runtimeBundle);
  if (remoteWorkerRuntimeBundleManifestSha256(bundle) !== input.runtimeBundleSha256) throw workerMeshRejected();
  const image = path.win32.relative(input.runtimeRoot as string, input.image as string).replaceAll("\\", "/");
  if (!bundle.files.some((file) => file.relativePath === image && file.sha256 === input.imageSha256)) throw workerMeshRejected();
  const limits = workerMeshRecord(input.limits, ["processLimit", "memoryBytes", "cpuMilli", "wallMs", "rawOutputBytes", "diagnosticBytes", "inputBytes"]);
  for (const [key, minimum, maximum] of [["processLimit", 1, 4096], ["memoryBytes", 1, Number.MAX_SAFE_INTEGER],
    ["cpuMilli", 1, 0xffffffff], ["wallMs", 1, 25000], ["rawOutputBytes", 1, 64 * 1024 * 1024],
    ["diagnosticBytes", 0, 65536], ["inputBytes", 0, 1024 * 1024]] as const) {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw workerMeshRejected();
  }
  if ((limits.diagnosticBytes as number) > (limits.rawOutputBytes as number)) throw workerMeshRejected();
  if (!input.environment || typeof input.environment !== "object" || Array.isArray(input.environment)) throw workerMeshRejected();
  const environment = Object.entries(input.environment);
  const names = new Set<string>();
  let characters = 1;
  for (const [name, value] of environment) {
    if (!/^[a-zA-Z0-9_]+$/u.test(name) || names.has(name.toLowerCase()) || typeof value !== "string" || value.includes("\0") ||
      !text(`${name}=${value}`, 8192)) throw workerMeshRejected();
    names.add(name.toLowerCase()); characters += name.length + 1 + value.length + 1;
  }
  if (environment.length > 64 || characters > 32767) throw workerMeshRejected();
  return input as unknown as WindowsWorkerStdioLaunch;
}

/** Bytes are frozen before any asynchronous authority check or process launch. */
export function encodeWindowsWorkerStdioLaunch(value: unknown): Buffer {
  const input = normalizeWindowsWorkerStdioLaunch(value);
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
  if (body.length > 512 * 1024) throw workerMeshRejected();
  const header = Buffer.alloc(12); header.write(input.protectedWorkspace ? "GCSTDIO2" : "GCSTDIO1", "ascii"); header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}
export function encodeWindowsWorkerStdioFrame(kind: 1 | 2 | 3, value: Uint8Array = Buffer.alloc(0)): Buffer {
  if (![1, 2, 3].includes(kind) || !(value instanceof Uint8Array) || value.byteLength > 65536 ||
    (kind === 1 ? !value.byteLength : value.byteLength !== 0)) throw workerMeshRejected();
  const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32LE(value.byteLength, 1);
  return Buffer.concat([header, value]);
}
export function decodeWindowsWorkerStdioCompletion(bytes: Uint8Array): WindowsWorkerStdioCompletion {
  if (bytes.length > 4096) throw workerMeshRejected();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  const numeric = ["bridgeError", "end", "error", "processExitCode", "processId", "standardInputBytesWritten", "standardOutputBytes", "standardErrorBytes"];
  const booleans = ["runtimeBundleVerified", "zeroProcessesVerified", "outputDrained", "appContainerVerified", "launchFilesVerified", "processImageVerified", "protectedWorkspaceVerified", "standardInputComplete"];
  const record = workerMeshRecord(value, ["schemaVersion", "runtimeBundleSha256", ...numeric, ...booleans]);
  if (record.schemaVersion !== "goatcitadel.worker-native-stdio.v1" || typeof record.runtimeBundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.runtimeBundleSha256)) throw workerMeshRejected();
  for (const name of numeric) if (typeof record[name] !== "number" || !Number.isSafeInteger(record[name]) || (record[name] as number) < 0) throw workerMeshRejected();
  for (const name of booleans) if (typeof record[name] !== "boolean") throw workerMeshRejected();
  if ((record.end as number) > 5 || (record.standardInputBytesWritten as number) > 1024 * 1024 ||
    (record.standardOutputBytes as number) + (record.standardErrorBytes as number) > 64 * 1024 * 1024 + 8192) throw workerMeshRejected();
  return Object.freeze(record) as unknown as WindowsWorkerStdioCompletion;
}
