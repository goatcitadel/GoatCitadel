import { sha256BytesHex } from "./sha256.js";
import { REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES } from "./remote-worker-native-pool-capacity-response.js";

export const REMOTE_WORKER_INSTALL_CAPACITY_CHALLENGE_BYTES = 144;
export const REMOTE_WORKER_INSTALL_CAPACITY_MAXIMUM_CHECKS = 65536;
export interface RemoteWorkerInstallCapacityBinding {
  readonly connectionNonceHex: string;
  readonly installationNonce: string;
  readonly requestSha256: string;
  readonly captureSha256: string;
  readonly byteLength: number;
}
const fields = ["connectionNonceHex", "installationNonce", "requestSha256", "captureSha256", "byteLength"] as const;
const captureDomain = new TextEncoder().encode("goatcitadel.worker-install-capacity-capture.v1\0");
const refused = () => new TypeError("Installation capacity challenge differs from its retained live reservation.");

/** Transport binding only. The full capture still requires independent pool,
 * layout and history validation and current canonical installation admission. */
export function hashRemoteWorkerInstallCapacityCapture(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES) throw refused();
  const payload = new Uint8Array(captureDomain.length + bytes.byteLength);
  payload.set(captureDomain); payload.set(bytes, captureDomain.length);
  return sha256BytesHex(payload);
}
export function normalizeRemoteWorkerInstallCapacityBinding(input: RemoteWorkerInstallCapacityBinding): RemoteWorkerInstallCapacityBinding {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(field => !descriptors[field] || !("value" in descriptors[field]!))) throw refused();
  const value = Object.fromEntries(fields.map(field => [field, descriptors[field]!.value])) as unknown as RemoteWorkerInstallCapacityBinding;
  for (const field of fields.slice(0, 4)) {
    const digest = value[field];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest) || /^0+$/u.test(digest)) throw refused();
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES) throw refused();
  return Object.freeze(value);
}

/** Four exact digests, ordinal, version, byte length, and a zero reserved word.
 * Ordinals are caller-retained and strictly sequential; echoes cannot establish
 * a reservation or reset its counter after reconnect. */
export function encodeRemoteWorkerInstallCapacityChallenge(input: RemoteWorkerInstallCapacityBinding, ordinal: number): Uint8Array {
  const binding = normalizeRemoteWorkerInstallCapacityBinding(input);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > REMOTE_WORKER_INSTALL_CAPACITY_MAXIMUM_CHECKS) throw refused();
  const bytes = new Uint8Array(REMOTE_WORKER_INSTALL_CAPACITY_CHALLENGE_BYTES);
  for (const [index, field] of ["connectionNonceHex", "installationNonce", "requestSha256", "captureSha256"].entries()) {
    const hex = binding[field as keyof Omit<RemoteWorkerInstallCapacityBinding, "byteLength">];
    for (let offset = 0; offset < 32; offset++) bytes[index * 32 + offset] = Number.parseInt(hex.slice(offset * 2, offset * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(128, ordinal, true); view.setUint32(132, 1, true); view.setUint32(136, binding.byteLength, true);
  return bytes;
}
export function assertRemoteWorkerInstallCapacityChallenge(bytes: Uint8Array, expected: RemoteWorkerInstallCapacityBinding, ordinal: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== REMOTE_WORKER_INSTALL_CAPACITY_CHALLENGE_BYTES) throw refused();
  const encoded = encodeRemoteWorkerInstallCapacityChallenge(expected, ordinal);
  for (let index = 0; index < REMOTE_WORKER_INSTALL_CAPACITY_CHALLENGE_BYTES; index++) if (bytes[index] !== encoded[index]) throw refused();
}
