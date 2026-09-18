import { REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES } from "./remote-worker-native-capacity-delivery.js";

export const REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES = 32768;
export const REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA = "goatcitadel.native-capacity-page-exchange.v1" as const;
export interface RemoteWorkerNativeCapacityPage {
  readonly kind: "cell.native_capacity.page";
  readonly nonce: string;
  readonly bundleSha256: string;
  readonly deliverySha256: string;
  readonly byteLength: number;
  readonly offset: number;
  readonly bytesHex: string;
}
export type RemoteWorkerNativeCapacityPageSubmission = RemoteWorkerNativeCapacityPage | Readonly<{
  kind: "cell.native_capacity.lookup"; nonce: string; bundleSha256: string;
}>;
export interface RemoteWorkerNativeCapacityPageReceipt {
  readonly bundleSha256: string;
  readonly deliverySha256: string;
  readonly captureSha256: string;
  readonly inventorySha256: string;
  readonly byteLength: number;
  readonly revision: number;
  readonly decision: "accept" | "quarantine";
}
export interface RemoteWorkerNativeCapacityPageExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly nonce: string;
  readonly bundleSha256: string;
  readonly record: RemoteWorkerNativeCapacityPageReceipt | null;
  readonly accepted: Readonly<{ page: RemoteWorkerNativeCapacityPage; nextOffset: number }> | null;
}
const refused = () => new TypeError("Native capacity page or receipt does not bind its protected capture.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value as unknown]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused();
  return value;
}
function integer(value: unknown, min: number, max = 2147483647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw refused(); return value;
}
function size(value: unknown): number { return integer(value, 2, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw refused();
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) throw refused();
  return value;
}
export function normalizeRemoteWorkerNativeCapacityPageSubmission(input: unknown): RemoteWorkerNativeCapacityPageSubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind !== "cell.native_capacity.page" && kind !== "cell.native_capacity.lookup") throw refused();
  const value = fields(input, kind === "cell.native_capacity.lookup" ? ["kind", "nonce", "bundleSha256"] :
    ["kind", "nonce", "bundleSha256", "deliverySha256", "byteLength", "offset", "bytesHex"]);
  const nonce = digest(value.nonce), bundleSha256 = digest(value.bundleSha256);
  if (kind === "cell.native_capacity.lookup") return Object.freeze({ kind, nonce, bundleSha256 });
  const byteLength = size(value.byteLength), offset = integer(value.offset, 0, byteLength - 1);
  if (offset % REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES || typeof value.bytesHex !== "string" ||
      value.bytesHex.length !== Math.min(REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES, byteLength - offset) * 2 || !/^[0-9a-f]+$/u.test(value.bytesHex)) throw refused();
  return Object.freeze({ kind, nonce, bundleSha256, deliverySha256: digest(value.deliverySha256), byteLength, offset, bytesHex: value.bytesHex });
}
export function normalizeRemoteWorkerNativeCapacityPageReceipt(input: unknown): RemoteWorkerNativeCapacityPageReceipt {
  const row = fields(input, ["bundleSha256", "deliverySha256", "captureSha256", "inventorySha256", "byteLength", "revision", "decision"]);
  if (row.decision !== "accept" && row.decision !== "quarantine") throw refused();
  return Object.freeze({ bundleSha256: digest(row.bundleSha256), deliverySha256: digest(row.deliverySha256),
    captureSha256: digest(row.captureSha256), inventorySha256: digest(row.inventorySha256),
    byteLength: size(row.byteLength), revision: integer(row.revision, 1), decision: row.decision });
}
export function normalizeRemoteWorkerNativeCapacityPageExchange(input: unknown): RemoteWorkerNativeCapacityPageExchange {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "nonce", "bundleSha256", "record", "accepted"]);
  if (value.schemaVersion !== REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA) throw refused();
  const binding = { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, registryWorkspaceId: identifier(value.registryWorkspaceId),
    assignmentId: identifier(value.assignmentId), assignmentGeneration: integer(value.assignmentGeneration, 1), leaseRevision: integer(value.leaseRevision, 1),
    nonce: digest(value.nonce), bundleSha256: digest(value.bundleSha256) };
  const record = value.record === null ? null : normalizeRemoteWorkerNativeCapacityPageReceipt(value.record);
  if (record && record.bundleSha256 !== binding.bundleSha256) throw refused();
  let accepted: RemoteWorkerNativeCapacityPageExchange["accepted"] = null;
  if (value.accepted !== null) {
    const ack = fields(value.accepted, ["page", "nextOffset"]), page = normalizeRemoteWorkerNativeCapacityPageSubmission(ack.page);
    if (page.kind !== "cell.native_capacity.page" || page.nonce !== binding.nonce || page.bundleSha256 !== binding.bundleSha256) throw refused();
    const nextOffset = integer(ack.nextOffset, page.offset + page.bytesHex.length / 2, page.byteLength);
    if (record ? nextOffset !== page.byteLength || record.deliverySha256 !== page.deliverySha256 || record.byteLength !== page.byteLength :
      nextOffset === page.byteLength || nextOffset % REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES !== 0) throw refused();
    accepted = Object.freeze({ page, nextOffset });
  }
  return Object.freeze({ ...binding, record, accepted });
}
