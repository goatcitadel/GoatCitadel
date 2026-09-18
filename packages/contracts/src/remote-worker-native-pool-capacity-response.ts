import { canonicalJsonString } from "./canonical-json.js";
import { normalizeRemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { readRemoteWorkerNativeCapacityLayout, normalizeRemoteWorkerNativeCapacityLayout } from "./remote-worker-native-capacity-layout.js";
import { normalizeRemoteWorkerNativePoolCapacityWindow, type RemoteWorkerNativePoolCapacityWindow } from "./remote-worker-native-pool-capacity-composition.js";
import { createRemoteWorkerNativePoolCapacityDelivery } from "./remote-worker-native-pool-capacity-delivery.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { readRemoteWorkerNativeCapacityCapture } from "./remote-worker-native-capacity-capture.js";

/** Same conservative byte bound as the native encoder: 64 members, one host
 * capture and at most ceil(20,000 / 20) + 63 guest chunks. */
export const REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES = 88 + 384 + 840 + 48 * 20000 + 64 * (8 + 352 + 424) + 1063 * 1000;
const refused = () => new TypeError("Native pool response must bind the complete independently retained capture.");

/** Decode a complete GCPRESP1 response against independent evidence.
 * The caller retains pool/layout/window and shared references independently;
 * incoming bytes never select those bindings or grant capture authority.
 * Publishing an observation requires successful terminal transport. Installation
 * admission may validate it earlier only inside an authenticated, retained
 * writer-exclusion window bound to the exact installation/capture challenge;
 * validation alone never publishes evidence or grants copying permission. */
export function readRemoteWorkerNativePoolCapacityResponse(input: unknown,
  retainedPool: RemoteWorkerNativePoolSnapshot, retainedLayout: unknown,
  retainedWindow: RemoteWorkerNativePoolCapacityWindow, retainedReferences: unknown) {
  const parsed = decodeResponse(input, retainedPool, retainedLayout);
  const window = normalizeRemoteWorkerNativePoolCapacityWindow(retainedWindow);
  if (parsed.connectionNonceHex !== window.connectionNonceHex || remoteWorkerCellCanonicalSha256(parsed.pool) !== window.poolSnapshotSha256) throw refused();
  return createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: parsed.layout, window,
    source: { ...parsed.source, references: retainedReferences } }), parsed.pool, window.nonce);
}

/** Trusted local capture producer only, after authenticated native terminal
 * receipt, clean helper exit and current authority checks. Derives provenance
 * from the completed native bytes; this is not the Gateway ingress reader and
 * cannot grant capture, admission or execution authority. Gateway retention
 * must independently retain and compare the resulting capture window. */
export function captureRemoteWorkerNativePoolCapacityResponse(input: unknown,
  retainedPool: RemoteWorkerNativePoolSnapshot, retainedLayout: unknown, captureNonce: string, retainedReferences: unknown) {
  const parsed = decodeResponse(input, retainedPool, retainedLayout);
  const host = readRemoteWorkerNativeCapacityCapture(parsed.source.hostCaptureHex, captureNonce, parsed.layout);
  const source = { ...parsed.source, references: retainedReferences };
  const window = normalizeRemoteWorkerNativePoolCapacityWindow({ nonce: captureNonce, connectionNonceHex: parsed.connectionNonceHex,
    poolSnapshotSha256: remoteWorkerCellCanonicalSha256(parsed.pool), hostCaptureSha256: host.captureSha256,
    membersSha256: remoteWorkerCellCanonicalSha256(source.members), referencesSha256: remoteWorkerCellCanonicalSha256(retainedReferences) });
  return createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: parsed.layout, window, source }), parsed.pool, captureNonce);
}

function decodeResponse(input: unknown, retainedPool: RemoteWorkerNativePoolSnapshot, retainedLayout: unknown) {
  if (typeof input !== "string" || input.length < (88 + 384 + 840) * 2 ||
      input.length > REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES * 2 || input.length % 2 || !/^[0-9a-f]+$/u.test(input)) throw refused();
  const pool = normalizeRemoteWorkerNativePoolSnapshot(retainedPool), layout = normalizeRemoteWorkerNativeCapacityLayout(retainedLayout);
  // Parse bounded fixed fields directly from immutable hex; avoid allocation
  // from untrusted counts or executing properties on peer-controlled objects.
  const u32 = (offset: number) => {
    if (offset + 4 > input.length / 2) throw refused();
    let value = 0;
    for (let i = 0; i < 4; ++i) value += Number.parseInt(input.slice((offset + i) * 2, (offset + i + 1) * 2), 16) * 2 ** (8 * i);
    return value;
  };
  const count = u32(12), hostBytes = u32(16);
  if (input.slice(0, 16) !== "4743505245535031" || u32(8) !== 1 || u32(20) !== 0 ||
      count !== pool.members.length || count < 1 || count > 64 || hostBytes < 840 || hostBytes > 840 + 48 * 20000 ||
      (hostBytes - 840) % 48 || /^0+$/u.test(input.slice(48, 112)) || input.slice(112, 176) !== remoteWorkerCellCanonicalSha256(pool)) throw refused();
  let position = 88;
  const take = (bytes: number) => {
    if (bytes > input.length / 2 - position) throw refused();
    const result = input.slice(position * 2, (position + bytes) * 2); position += bytes; return result;
  };
  if (canonicalJsonString(readRemoteWorkerNativeCapacityLayout(take(384))) !== canonicalJsonString(layout)) throw refused();
  const hostCaptureHex = take(hostBytes);
  let chunks = 0;
  const members = Array.from({ length: count }, (_, index) => {
    const ordinal = u32(position), chunkCount = u32(position + 4); position += 8;
    if (ordinal !== index || chunkCount < 1 || chunkCount > 1063 - chunks ||
        352 + 424 + chunkCount * 1000 > input.length / 2 - position) throw refused();
    chunks += chunkCount;
    return { guestObservationHex: take(352), backingObservationHex: take(424),
      guestChunkHex: Array.from({ length: chunkCount }, () => take(1000)) };
  });
  if (position !== input.length / 2) throw refused();
  return { pool, layout, connectionNonceHex: input.slice(48, 112), source: { hostCaptureHex, members } };
}
