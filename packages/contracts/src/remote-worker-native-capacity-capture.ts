import { canonicalJsonString } from "./canonical-json.js";
import { sha256BytesHex } from "./sha256.js";
import { REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerNativeCapacityLayout, readRemoteWorkerNativeCapacityLayout,
  remoteWorkerNativeCapacityIdentitySha256, type RemoteWorkerNativeCapacityLayout } from "./remote-worker-native-capacity-layout.js";
import type { RemoteWorkerCellCapacityInventoryArea, RemoteWorkerCellCapacityInventoryObject } from "./remote-worker-cell-capacity-inventory.js";

export const REMOTE_WORKER_NATIVE_CAPACITY_CAPTURE_MAX_BYTES = 960840;
export interface RemoteWorkerNativeCapacityCapture {
  readonly nonce: string;
  readonly nativeLayout: RemoteWorkerNativeCapacityLayout;
  readonly captureSha256: string;
  readonly areas: readonly RemoteWorkerCellCapacityInventoryArea[];
}
const refused = () => new TypeError("Native capacity capture does not match its independently retained layout and capture window.");
function hash(domain: string, bytes: Uint8Array): string {
  const prefix = new TextEncoder().encode(domain + "\0"), input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length); return sha256BytesHex(input);
}
/** Host directory observations only. Guest/backing composition, shared logical
 * references and complete installed pool coverage remain the admission owner's
 * responsibility. No execution, cleanup or quota authority comes from a frame. */
export function readRemoteWorkerNativeCapacityCapture(input: unknown, expectedNonce: unknown,
  suppliedLayout: unknown): RemoteWorkerNativeCapacityCapture {
  if (typeof input !== "string" || input.length < 2 * (840 + 48 * 13) || input.length > 2 * REMOTE_WORKER_NATIVE_CAPACITY_CAPTURE_MAX_BYTES ||
      input.length % 2 || !/^[0-9a-f]+$/u.test(input) || typeof expectedNonce !== "string" ||
      !/^[0-9a-f]{64}$/u.test(expectedNonce) || /^0+$/u.test(expectedNonce)) throw refused();
  const expected = normalizeRemoteWorkerNativeCapacityLayout(suppliedLayout), hex = (start: number, end: number) => input.slice(start * 2, end * 2);
  if (hex(0, 8) !== "4743434150303031" || hex(8, 40) !== expectedNonce) throw refused();
  const nativeLayout = readRemoteWorkerNativeCapacityLayout(hex(40, 424));
  if (canonicalJsonString(nativeLayout) !== canonicalJsonString(expected)) throw refused();
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer), u32 = (offset: number) => view.getUint32(offset, true);
  const u64 = (offset: number) => {
    const value = Number(view.getBigUint64(offset, true)); if (!Number.isSafeInteger(value)) throw refused(); return value;
  };
  const captureSha256 = hash("goatcitadel.native-capacity-capture.v1", bytes), identities = new Set<string>();
  let position = 840, total = 0;
  const areas = REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.map((category, area) => {
    const summary = 424 + 32 * area, count = u32(summary), files = u32(summary + 4), directories = u32(summary + 8);
    const root = nativeLayout.rootIdentityHex[area]!, expectedLogical = u64(summary + 16), expectedAllocated = u64(summary + 24);
    total += count;
    if (!count || total > 20000 || files + directories !== count || !directories || u32(summary + 12) ||
        position + 48 * count > bytes.length) throw refused();
    let logical = 0, allocated = 0, observedFiles = 0, observedDirectories = 0, rootFound = false, previous = "";
    const objects: RemoteWorkerCellCapacityInventoryObject[] = [];
    for (let i = 0; i < count; i++, position += 48) {
      const identity = hex(position, position + 24), kind = u32(position + 24), logicalBytes = u64(position + 32), allocatedBytes = u64(position + 40);
      if (u32(position + 28) || (kind !== 1 && kind !== 2) || identity.slice(0, 16) !== root.slice(0, 16) ||
          (previous && identity <= previous) || identities.has(identity) || (kind === 2 && logicalBytes)) throw refused();
      previous = identity; identities.add(identity);
      if (identity === root) { if (kind !== 2) throw refused(); rootFound = true; }
      if (kind === 2) observedDirectories++; else observedFiles++;
      logical += logicalBytes; allocated += allocatedBytes;
      if (!Number.isSafeInteger(logical) || !Number.isSafeInteger(allocated)) throw refused();
      objects.push(Object.freeze({ identitySha256: remoteWorkerNativeCapacityIdentitySha256(identity), kind: kind === 2 ? "directory" : "file",
        logicalBytes, allocatedBytes, backingIdentitySha256: null }));
    }
    if (!rootFound || observedFiles !== files || observedDirectories !== directories || logical !== expectedLogical || allocated !== expectedAllocated) throw refused();
    return Object.freeze({ category, evidenceSha256: hash("goatcitadel.native-capacity-area.v1", new TextEncoder().encode(`${captureSha256}:${area}`)),
      objects: Object.freeze(objects) });
  });
  if (position !== bytes.length) throw refused();
  return Object.freeze({ nonce: expectedNonce, nativeLayout, captureSha256, areas: Object.freeze(areas) });
}
