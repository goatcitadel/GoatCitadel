import { createHash, createPublicKey, verify } from "node:crypto";
import {
  buildRemoteWorkerPopV2Preimage,
  canonicalJsonString,
  type RemoteWorkerPopV2Input,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
} from "@goatcitadel/contracts";

/** Public custody identity. A retained reference never chooses an executable or contains a secret. */
export interface WorkerProtectedKeyReference {
  readonly kind: "windows_provisioner";
  readonly keysetGeneration: number;
  readonly protectedStateSha256: string;
  readonly keysetReceiptSha256: string;
  readonly workerPublicKeySpkiBase64Url: string;
}

/** Installed composition supplies this owner; durable JSON cannot instantiate it. */
export interface WorkerProtectedKeyOwner {
  readonly reference: WorkerProtectedKeyReference;
  readonly admissionSignerSpkiBase64Url: string;
  signPopV2(input: {
    readonly reference: WorkerProtectedKeyReference;
    readonly preimage: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<string>;
  signAdmissionEnvelope(input: {
    readonly reference: WorkerProtectedKeyReference;
    readonly envelope: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<RemoteWorkerProtectedAdmissionEvidenceWire>;
}

const REFERENCE_FIELDS = [
  "kind",
  "keysetGeneration",
  "protectedStateSha256",
  "keysetReceiptSha256",
  "workerPublicKeySpkiBase64Url",
].sort();
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function workerProtectedPublicSpki(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("Worker protected public key is invalid.");
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length !== 44 ||
    bytes.toString("base64url") !== value ||
    !bytes.subarray(0, 12).equals(SPKI_PREFIX) ||
    bytes.subarray(12).every((byte) => byte === 0)
  )
    throw new Error("Worker protected public key is not canonical Ed25519 SPKI.");
  return bytes;
}

export function normalizeWorkerProtectedKeyReference(value: unknown): WorkerProtectedKeyReference {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.keys(value).sort().join("|") !== REFERENCE_FIELDS.join("|")
  )
    throw new Error("Worker protected key reference has unexpected fields.");
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "windows_provisioner" ||
    !Number.isSafeInteger(record.keysetGeneration) ||
    (record.keysetGeneration as number) < 1
  )
    throw new Error("Worker protected key reference generation is invalid.");
  const digest = (input: unknown): string => {
    if (typeof input !== "string" || !/^[0-9a-f]{64}$/u.test(input) || /^0+$/u.test(input))
      throw new Error("Worker protected key reference digest is invalid.");
    return input;
  };
  const spki = workerProtectedPublicSpki(record.workerPublicKeySpkiBase64Url);
  return Object.freeze({
    kind: "windows_provisioner",
    keysetGeneration: record.keysetGeneration as number,
    protectedStateSha256: digest(record.protectedStateSha256),
    keysetReceiptSha256: digest(record.keysetReceiptSha256),
    workerPublicKeySpkiBase64Url: spki.toString("base64url"),
  });
}

export function workerProtectedKeySpkiSha256(reference: WorkerProtectedKeyReference): string {
  return createHash("sha256").update(workerProtectedPublicSpki(reference.workerPublicKeySpkiBase64Url)).digest("hex");
}

export function requireWorkerProtectedKeyOwner(
  reference: WorkerProtectedKeyReference,
  owner: WorkerProtectedKeyOwner | undefined,
): WorkerProtectedKeyOwner {
  const expected = normalizeWorkerProtectedKeyReference(reference);
  if (
    !owner ||
    canonicalJsonString(normalizeWorkerProtectedKeyReference(owner.reference)) !== canonicalJsonString(expected) ||
    typeof owner.signPopV2 !== "function" ||
    typeof owner.signAdmissionEnvelope !== "function"
  )
    throw new Error("Worker protected key owner is unavailable or differs from retained authority.");
  const admissionSignerSpkiBase64Url = workerProtectedPublicSpki(owner.admissionSignerSpkiBase64Url).toString(
    "base64url",
  );
  return Object.freeze({
    reference: expected,
    admissionSignerSpkiBase64Url,
    signPopV2: owner.signPopV2.bind(owner),
    signAdmissionEnvelope: owner.signAdmissionEnvelope.bind(owner),
  });
}

export async function signWorkerProtectedPop(input: {
  readonly reference: WorkerProtectedKeyReference;
  readonly owner: WorkerProtectedKeyOwner;
  readonly material: RemoteWorkerPopV2Input;
  readonly signal: AbortSignal;
}): Promise<string> {
  const owner = requireWorkerProtectedKeyOwner(input.reference, input.owner);
  const signal = input.signal;
  signal.throwIfAborted();
  if (
    input.material.workerGeneration !== owner.reference.keysetGeneration ||
    input.material.workerPublicKeySpkiSha256 !== workerProtectedKeySpkiSha256(owner.reference)
  )
    throw new Error("Worker protected proof differs from its key authority.");
  const preimage = Buffer.from(buildRemoteWorkerPopV2Preimage(input.material));
  const result = await owner.signPopV2({ reference: owner.reference, preimage: Buffer.from(preimage), signal });
  signal.throwIfAborted();
  if (typeof result !== "string") throw new Error("Worker protected signature is invalid.");
  const signature = Buffer.from(result, "base64url");
  const publicKey = createPublicKey({
    key: workerProtectedPublicSpki(owner.reference.workerPublicKeySpkiBase64Url),
    type: "spki",
    format: "der",
  });
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== result ||
    !verify(null, preimage, publicKey, signature)
  )
    throw new Error("Worker protected signature did not verify over the original request.");
  return result;
}
