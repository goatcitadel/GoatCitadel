import { sha256BytesHex } from "./sha256.js";
import {
  normalizeRemoteWorkerRuntimeBundleManifest,
  remoteWorkerRuntimeBundleManifestSha256,
  REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  type RemoteWorkerRuntimeBundleManifest,
} from "./remote-worker-runtime-bundle.js";

export const REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION = "goatcitadel.worker-runtime-install.v1" as const;
export const REMOTE_WORKER_RUNTIME_INSTALL_BYTES = 272;
const magic = new TextEncoder().encode("GCRINST1");
const names = ["node.exe", "worker-host-receipt.json"] as const;
const invalid = () => new Error("Native worker runtime installation request is invalid.");

export interface RemoteWorkerRuntimeInstallRequest {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION;
  readonly nonce: string;
  readonly journalIdentityHex: string;
  readonly preparedSha256: string;
  readonly checkpointSha256: string;
  readonly packageSha256: string;
  readonly runtimeBundle: RemoteWorkerRuntimeBundleManifest;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function hex(input: unknown, length = 64): string {
  if (typeof input !== "string" || input.length !== length || !/^[a-f0-9]+$/u.test(input) || /^0+$/u.test(input)) throw invalid();
  return input;
}

/** Metadata binding only. The caller must independently authorize installation,
 * package custody, journal phase, capacity and current assignment authority. */
export function normalizeRemoteWorkerRuntimeInstallRequest(input: unknown): RemoteWorkerRuntimeInstallRequest {
  const value = record(input, ["schemaVersion", "nonce", "journalIdentityHex", "preparedSha256", "checkpointSha256", "packageSha256", "runtimeBundle"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION) throw invalid();
  const journalIdentityHex = hex(value.journalIdentityHex, 48);
  hex(journalIdentityHex.slice(0, 16), 16);
  hex(journalIdentityHex.slice(16), 32);
  const runtimeBundle = normalizeRemoteWorkerRuntimeBundleManifest(value.runtimeBundle);
  if (runtimeBundle.files.length !== names.length || runtimeBundle.files.some((file, index) => file.relativePath !== names[index] || file.bytes === 0 || /^0+$/u.test(file.sha256))) throw invalid();
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION,
    nonce: hex(value.nonce), journalIdentityHex,
    preparedSha256: hex(value.preparedSha256), checkpointSha256: hex(value.checkpointSha256),
    packageSha256: hex(value.packageSha256), runtimeBundle,
  });
}

function put(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 2) bytes[offset + index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
}
function read(bytes: Uint8Array, offset: number, length: number): string {
  return [...bytes.subarray(offset, offset + length)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeRemoteWorkerRuntimeInstallRequest(input: unknown): Uint8Array {
  const value = normalizeRemoteWorkerRuntimeInstallRequest(input);
  const bytes = new Uint8Array(REMOTE_WORKER_RUNTIME_INSTALL_BYTES);
  bytes.set(magic);
  put(bytes, 8, value.nonce); put(bytes, 40, value.journalIdentityHex);
  put(bytes, 64, value.preparedSha256); put(bytes, 96, value.checkpointSha256);
  put(bytes, 128, value.packageSha256);
  put(bytes, 160, remoteWorkerRuntimeBundleManifestSha256(value.runtimeBundle));
  const view = new DataView(bytes.buffer);
  value.runtimeBundle.files.forEach((file, index) => {
    view.setBigUint64(192 + index * 40, BigInt(file.bytes), true);
    put(bytes, 200 + index * 40, file.sha256);
  });
  return bytes;
}

function digest(bytes: Uint8Array): string {
  const domain = new TextEncoder().encode(`${REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION}\0`);
  const combined = new Uint8Array(domain.length + bytes.length);
  combined.set(domain); combined.set(bytes, domain.length);
  return sha256BytesHex(combined);
}

export function remoteWorkerRuntimeInstallRequestSha256(input: unknown): string {
  return digest(encodeRemoteWorkerRuntimeInstallRequest(input));
}

/** Expected binding must come from the protected admission owner, independently
 * of this frame. A matching digest alone grants no installation permission. */
export function decodeRemoteWorkerRuntimeInstallRequest(
  input: Uint8Array, expected: { readonly nonce: string; readonly requestSha256: string },
): RemoteWorkerRuntimeInstallRequest {
  const binding = record(expected, ["nonce", "requestSha256"]);
  const nonce = hex(binding.nonce), requestSha256 = hex(binding.requestSha256);
  if (!(input instanceof Uint8Array) || input.byteLength !== REMOTE_WORKER_RUNTIME_INSTALL_BYTES) throw invalid();
  const bytes = Uint8Array.from(input);
  if (magic.some((byte, index) => bytes[index] !== byte) || digest(bytes) !== requestSha256 || read(bytes, 8, 32) !== nonce) throw invalid();
  const view = new DataView(bytes.buffer);
  const value = normalizeRemoteWorkerRuntimeInstallRequest({
    schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce,
    journalIdentityHex: read(bytes, 40, 24), preparedSha256: read(bytes, 64, 32),
    checkpointSha256: read(bytes, 96, 32), packageSha256: read(bytes, 128, 32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: names.map((relativePath, index) => ({
      relativePath, bytes: Number(view.getBigUint64(192 + index * 40, true)), sha256: read(bytes, 200 + index * 40, 32),
    })) },
  });
  if (remoteWorkerRuntimeBundleManifestSha256(value.runtimeBundle) !== read(bytes, 160, 32)) throw invalid();
  return value;
}
