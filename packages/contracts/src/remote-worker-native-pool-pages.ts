import { canonicalJsonString } from "./canonical-json.js";
import { sha256BytesHex } from "./sha256.js";
import { normalizeRemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { normalizeRemoteWorkerNativePoolCleanupSnapshot, type RemoteWorkerNativePoolCleanupSnapshot } from "./remote-worker-native-pool-cleanup.js";

export const REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES = 32 * 1024;
export const REMOTE_WORKER_NATIVE_POOL_MAX_BYTES = 8 * 1024 * 1024;
export type RemoteWorkerNativePoolPageSubmission = Readonly<{
  kind: "cell.native_pool.page"; snapshotSha256: string | null; offset: number;
}>;
export type RemoteWorkerNativePoolCleanupPageSubmission = Readonly<{
  kind: "cell.native_pool.cleanup.page"; snapshotSha256: string | null; offset: number;
}>;
export type RemoteWorkerNativePoolPage = Readonly<{
  snapshotSha256: string; offset: number; byteLength: number; bytesHex: string;
}>;
const refused = () => new Error("Native pool page is invalid or its snapshot changed.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null) || Reflect.ownKeys(input).length !== keys.length) throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    result[key] = descriptor.value;
  }
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw refused();
  return value;
}
function offset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= REMOTE_WORKER_NATIVE_POOL_MAX_BYTES ||
      (value as number) % REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES !== 0) throw refused();
  return value as number;
}
export function normalizeRemoteWorkerNativePoolPageSubmission(input: unknown): RemoteWorkerNativePoolPageSubmission {
  return submission(input, "cell.native_pool.page");
}
export function normalizeRemoteWorkerNativePoolCleanupPageSubmission(input: unknown): RemoteWorkerNativePoolCleanupPageSubmission {
  return submission(input, "cell.native_pool.cleanup.page");
}
function submission<T extends RemoteWorkerNativePoolPageSubmission["kind"] | RemoteWorkerNativePoolCleanupPageSubmission["kind"]>(input: unknown, kind: T) {
  const value = fields(input, ["kind", "snapshotSha256", "offset"]);
  if (value.kind !== kind) throw refused();
  const position = offset(value.offset), snapshotSha256 = value.snapshotSha256 === null ? null : hash(value.snapshotSha256);
  if (position !== 0 && snapshotSha256 === null) throw refused();
  return Object.freeze({ kind, offset: position, snapshotSha256 });
}
export function normalizeRemoteWorkerNativePoolPage(input: unknown): RemoteWorkerNativePoolPage {
  const value = fields(input, ["snapshotSha256", "offset", "byteLength", "bytesHex"]), position = offset(value.offset);
  const size = value.byteLength;
  if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > REMOTE_WORKER_NATIVE_POOL_MAX_BYTES || position >= (size as number)) throw refused();
  const bytes = Math.min(REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES, (size as number) - position);
  if (typeof value.bytesHex !== "string" || value.bytesHex.length !== bytes * 2 || !/^[a-f0-9]+$/u.test(value.bytesHex)) throw refused();
  return Object.freeze({ snapshotSha256: hash(value.snapshotSha256), offset: position, byteLength: size as number, bytesHex: value.bytesHex });
}
/** Re-read canonical membership for every request. No page may continue from a
 * changed snapshot, and a partial transfer is never a usable pool. */
export function createRemoteWorkerNativePoolPage(snapshot: RemoteWorkerNativePoolSnapshot, submission: RemoteWorkerNativePoolPageSubmission): RemoteWorkerNativePoolPage {
  return createPage(normalizeRemoteWorkerNativePoolSnapshot(snapshot), normalizeRemoteWorkerNativePoolPageSubmission(submission));
}
export function createRemoteWorkerNativePoolCleanupPage(snapshot: RemoteWorkerNativePoolCleanupSnapshot,
  submission: RemoteWorkerNativePoolCleanupPageSubmission): RemoteWorkerNativePoolPage {
  return createPage(normalizeRemoteWorkerNativePoolCleanupSnapshot(snapshot), normalizeRemoteWorkerNativePoolCleanupPageSubmission(submission));
}
function createPage(snapshot: unknown, request: Pick<RemoteWorkerNativePoolPageSubmission, "offset" | "snapshotSha256">): RemoteWorkerNativePoolPage {
  const bytes = new TextEncoder().encode(canonicalJsonString(snapshot));
  if (bytes.length > REMOTE_WORKER_NATIVE_POOL_MAX_BYTES || request.offset >= bytes.length) throw refused();
  const snapshotSha256 = sha256BytesHex(bytes);
  if (request.snapshotSha256 !== null && request.snapshotSha256 !== snapshotSha256) throw refused();
  const bytesHex = Array.from(bytes.subarray(request.offset, request.offset + REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES), byte => byte.toString(16).padStart(2, "0")).join("");
  return normalizeRemoteWorkerNativePoolPage({ snapshotSha256, offset: request.offset, byteLength: bytes.length, bytesHex });
}
export function assembleRemoteWorkerNativePoolPages(input: readonly RemoteWorkerNativePoolPage[]): RemoteWorkerNativePoolSnapshot {
  return assemblePages(input, normalizeRemoteWorkerNativePoolSnapshot);
}
export function assembleRemoteWorkerNativePoolCleanupPages(input: readonly RemoteWorkerNativePoolPage[]): RemoteWorkerNativePoolCleanupSnapshot {
  return assemblePages(input, normalizeRemoteWorkerNativePoolCleanupSnapshot);
}
function assemblePages<T>(input: readonly RemoteWorkerNativePoolPage[], normalize: (value: unknown) => T): T {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 ||
      input.length > REMOTE_WORKER_NATIVE_POOL_MAX_BYTES / REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES || Reflect.ownKeys(input).length !== input.length + 1) throw refused();
  const pages: RemoteWorkerNativePoolPage[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    pages.push(normalizeRemoteWorkerNativePoolPage(descriptor.value));
  }
  const first = pages[0]!;
  if (pages.length !== Math.ceil(first.byteLength / REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES)) throw refused();
  const bytes = new Uint8Array(first.byteLength);
  pages.forEach((page, index) => {
    if (page.snapshotSha256 !== first.snapshotSha256 || page.byteLength !== first.byteLength || page.offset !== index * REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES) throw refused();
    for (let position = 0; position < page.bytesHex.length; position += 2) bytes[page.offset + position / 2] = Number.parseInt(page.bytesHex.slice(position, position + 2), 16);
  });
  if (sha256BytesHex(bytes) !== first.snapshotSha256) throw refused();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const snapshot = normalize(JSON.parse(text));
  if (canonicalJsonString(snapshot) !== text) throw refused();
  return snapshot;
}
