import { sha256BytesHex } from "./sha256.js";
import { normalizeRemoteWorkerNativePoolCapacityWindow, type RemoteWorkerNativePoolCapacityWindow } from "./remote-worker-native-pool-capacity-composition.js";

export const REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES = 396;
export const REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS = 65536;
const magic = new TextEncoder().encode("GCCATT01");
const keyDomain = new TextEncoder().encode("goatcitadel.controller-attestation-key.v1\0");
const digestFields = ["keySha256", "controllerInstanceHex", "authoritySha256", "challengeNonceHex", "installationNonce", "requestSha256"] as const;
const windowFields = ["nonce", "connectionNonceHex", "poolSnapshotSha256", "hostCaptureSha256", "membersSha256", "referencesSha256"] as const;
const fields = [...digestFields, "ordinal", "window"] as const;
const refused = () => new TypeError("Invalid controller state attestation.");
export interface RemoteWorkerControllerEnrollment {
  readonly publicPointHex: string;
  readonly keySha256: string;
}
/** Operator-selected public pin carried by the canonical installation approval.
 * Worker transport must never create or replace this trust anchor. */
export function normalizeRemoteWorkerControllerEnrollment(input: unknown): RemoteWorkerControllerEnrollment {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 2 || !fields.publicPointHex?.enumerable || !fields.keySha256?.enumerable ||
      !("value" in fields.publicPointHex) || !("value" in fields.keySha256)) throw refused();
  const publicPointHex: unknown = fields.publicPointHex.value, keySha256: unknown = fields.keySha256.value;
  if (typeof publicPointHex !== "string" || typeof keySha256 !== "string" || hashRemoteWorkerControllerPublicKey(publicPointHex) !== keySha256) throw refused();
  return Object.freeze({ publicPointHex, keySha256 });
}

export interface RemoteWorkerControllerAttestation {
  readonly keySha256: string;
  readonly controllerInstanceHex: string;
  readonly authoritySha256: string;
  readonly challengeNonceHex: string;
  readonly installationNonce: string;
  readonly requestSha256: string;
  readonly ordinal: number;
  readonly window: RemoteWorkerNativePoolCapacityWindow;
}

/** Fixed binary signing input shared with the native controller. State fields
 * must originate in its held journal/capture, never in a worker signing request.
 * A valid signature alone does not establish enrollment or current authority. */
export function normalizeRemoteWorkerControllerAttestation(input: unknown): RemoteWorkerControllerAttestation {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(field => !descriptors[field]?.enumerable || !("value" in descriptors[field]!))) throw refused();
  const value = Object.fromEntries(fields.map(field => [field, descriptors[field]!.value])) as unknown as RemoteWorkerControllerAttestation;
  for (const field of digestFields) if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/u.test(value[field]) || /^0+$/u.test(value[field])) throw refused();
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS) throw refused();
  return Object.freeze({ ...value, window: normalizeRemoteWorkerNativePoolCapacityWindow(value.window) });
}

export function encodeRemoteWorkerControllerAttestation(input: RemoteWorkerControllerAttestation): Uint8Array {
  const value = normalizeRemoteWorkerControllerAttestation(input);
  const bytes = new Uint8Array(REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES);
  bytes.set(magic);
  new DataView(bytes.buffer).setUint32(8, value.ordinal, true);
  const digests = [...digestFields.map(field => value[field]), ...windowFields.map(field => value.window[field])];
  for (const [index, hex] of digests.entries()) for (let byte = 0; byte < 32; byte++) {
    bytes[12 + index * 32 + byte] = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
  }
  return bytes;
}

/** Fingerprint an uncompressed SEC1 P-256 public point. Curve membership is
 * additionally checked by the verifier; private key bytes never cross this API. */
export function hashRemoteWorkerControllerPublicKey(publicPointHex: string): string {
  if (typeof publicPointHex !== "string" || !/^04[0-9a-f]{128}$/u.test(publicPointHex)) throw refused();
  const bytes = new Uint8Array(keyDomain.length + 65);
  bytes.set(keyDomain);
  for (let index = 0; index < 65; index++) bytes[keyDomain.length + index] = Number.parseInt(publicPointHex.slice(index * 2, index * 2 + 2), 16);
  return sha256BytesHex(bytes);
}
