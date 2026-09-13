import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION = "goatcitadel.worker-runtime-bundle.v1" as const;
export const REMOTE_WORKER_RUNTIME_BUNDLE_MAX_FILES = 4096;
export const REMOTE_WORKER_RUNTIME_BUNDLE_MAX_DIRECTORIES = 4096;
export const REMOTE_WORKER_RUNTIME_BUNDLE_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const REMOTE_WORKER_RUNTIME_BUNDLE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface RemoteWorkerRuntimeBundleFile {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface RemoteWorkerRuntimeBundleManifest {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION;
  readonly files: readonly RemoteWorkerRuntimeBundleFile[];
}
const rejected = () => new Error("Native worker runtime bundle manifest is invalid.");

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) throw rejected();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key))) throw rejected();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (names.some((name) => !descriptors[name]?.enumerable || !("value" in descriptors[name]))) throw rejected();
  return value as Record<string, unknown>;
}

/** Matches the native exact-tree verifier. Bundle metadata is supplied by the
 * admitted package owner; this contract never approves current filesystem bytes. */
export function normalizeRemoteWorkerRuntimeBundleManifest(input: unknown): RemoteWorkerRuntimeBundleManifest {
  const manifest = record(input, ["schemaVersion", "files"]);
  const supplied = manifest.files;
  if (manifest.schemaVersion !== REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION || !Array.isArray(supplied) ||
      Object.getPrototypeOf(supplied) !== Array.prototype || supplied.length < 1 || supplied.length > REMOTE_WORKER_RUNTIME_BUNDLE_MAX_FILES ||
      Reflect.ownKeys(supplied).length !== supplied.length + 1) throw rejected();
  const names = new Map<string, string>();
  const directories = new Set<string>();
  const paths = new Set<string>();
  const files: RemoteWorkerRuntimeBundleFile[] = [];
  let total = 0;
  let previous = "";
  for (let index = 0; index < supplied.length; index++) {
    const element = Object.getOwnPropertyDescriptor(supplied, String(index));
    if (!element?.enumerable || !("value" in element)) throw rejected();
    const file = record(element.value, ["relativePath", "bytes", "sha256"]);
    const { relativePath, bytes, sha256 } = file;
    if (typeof relativePath !== "string" || !relativePath.length || relativePath.length > 512 ||
        !/^[\x20-\x7e]+$/u.test(relativePath) || relativePath.includes("\\") || relativePath <= previous ||
        typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > REMOTE_WORKER_RUNTIME_BUNDLE_MAX_FILE_BYTES ||
        typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw rejected();
    total += bytes;
    if (total > REMOTE_WORKER_RUNTIME_BUNDLE_MAX_TOTAL_BYTES) throw rejected();
    previous = relativePath;
    const components = relativePath.split("/");
    if (components.length > 64) throw rejected();
    for (let depth = 0; depth < components.length; depth++) {
      const component = components[depth]!;
      if (!component || component.length > 255 || /[. ]$/u.test(component) || /[:*?"<>|]/u.test(component)) throw rejected();
      const stem = component.split(".")[0]!.toUpperCase();
      if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9]|LPT[1-9])$/u.test(stem)) throw rejected();
      const prefix = components.slice(0, depth + 1).join("/");
      const lower = prefix.toLowerCase();
      if (names.has(lower) && names.get(lower) !== prefix) throw rejected();
      names.set(lower, prefix);
      if (depth + 1 < components.length) directories.add(prefix);
      if (directories.size > REMOTE_WORKER_RUNTIME_BUNDLE_MAX_DIRECTORIES) throw rejected();
    }
    paths.add(relativePath);
    files.push(Object.freeze({ relativePath, bytes, sha256 }));
  }
  if (directories.size > REMOTE_WORKER_RUNTIME_BUNDLE_MAX_DIRECTORIES || [...directories].some((name) => paths.has(name))) throw rejected();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: Object.freeze(files) });
}

/** Domain-separated LE32 count; each entry is LE32 ASCII-path length, path,
 * LE64 byte size and raw SHA-256. This is byte-identical to the native verifier. */
export function remoteWorkerRuntimeBundleManifestBytes(input: unknown): Uint8Array {
  const manifest = normalizeRemoteWorkerRuntimeBundleManifest(input);
  const domain = new TextEncoder().encode(`${REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION}\0`);
  const length = domain.length + 4 + manifest.files.reduce((size, file) => size + 4 + file.relativePath.length + 8 + 32, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(domain);
  let offset = domain.length;
  view.setUint32(offset, manifest.files.length, true); offset += 4;
  for (const file of manifest.files) {
    view.setUint32(offset, file.relativePath.length, true); offset += 4;
    for (const character of file.relativePath) bytes[offset++] = character.charCodeAt(0);
    view.setBigUint64(offset, BigInt(file.bytes), true); offset += 8;
    for (let index = 0; index < 64; index += 2) bytes[offset++] = Number.parseInt(file.sha256.slice(index, index + 2), 16);
  }
  return bytes;
}

export function remoteWorkerRuntimeBundleManifestSha256(input: unknown): string {
  return sha256BytesHex(remoteWorkerRuntimeBundleManifestBytes(input));
}
