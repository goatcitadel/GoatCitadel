import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { encodeRemoteWorkerControllerAttestation, hashRemoteWorkerControllerPublicKey,
  REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES, REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS,
  type RemoteWorkerNativePoolCapacityWindow } from "@goatcitadel/contracts";
import type { RemoteWorkerInstallationEndpoint } from "./remote-worker-installation-session.js";

export interface EnrolledControllerAttestationAuthority {
  readonly publicPointHex: string;
  readonly keySha256: string;
  /** Optional independently known instance; otherwise pin the first freshly
   * authenticated instance for this connection, never an unsigned hello. */
  readonly controllerInstanceHex?: string;
  readonly authoritySha256: string;
  readonly connectionNonceHex: string;
  readonly installationNonce: string;
  readonly requestSha256: string;
}
export interface ControllerAttestationTransport {
  readonly signal: AbortSignal;
  /** The controller derives all state from its retained native session. The
   * worker receives only a fresh challenge and cannot choose signed state. */
  challenge(nonceHex: string, ordinal: number, signal: AbortSignal): Promise<unknown>;
}
const refused = () => new Error("Controller attestation requires its current enrollment and native session.");

/** Call only with independently enrolled controller authority. Worker RPC must
 * never choose the public key, epoch, assignment binding or enrollment check. */
export function createControllerSignedInstallationEndpoint(
  supplied: EnrolledControllerAttestationAuthority,
  transport: ControllerAttestationTransport,
  assertEnrollmentCurrent: (signal: AbortSignal) => Promise<void>,
): RemoteWorkerInstallationEndpoint {
  const authority = Object.freeze({ ...supplied });
  if (hashRemoteWorkerControllerPublicKey(authority.publicPointHex) !== authority.keySha256) throw refused();
  const point = Buffer.from(authority.publicPointHex, "hex");
  const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw refused();
  const challenge = transport.challenge.bind(transport);
  const stop = new AbortController();
  const lifetime = AbortSignal.any([transport.signal, stop.signal]);
  let active = false, ordinal = 0;
  let controllerInstanceHex = authority.controllerInstanceHex;
  const fail = () => { stop.abort(refused()); return refused(); };
  return Object.freeze({
    connectionNonceHex: authority.connectionNonceHex,
    signal: lifetime,
    async verify(window: RemoteWorkerNativePoolCapacityWindow, callerSignal: AbortSignal): Promise<void> {
      if (active || lifetime.aborted || callerSignal.aborted || ordinal >= REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS) throw fail();
      active = true;
      const signal = AbortSignal.any([lifetime, callerSignal, AbortSignal.timeout(5000)]);
      try {
        if (window.connectionNonceHex !== authority.connectionNonceHex) throw refused();
        const nonce = randomBytes(32).toString("hex"), sequence = ++ordinal;
        await awaitControllerAuthority(() => assertEnrollmentCurrent(signal), signal);
        const result = await awaitControllerAuthority(() => challenge(nonce, sequence, signal), signal);
        if (!result || typeof result !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(result) as object | null)) throw refused();
        const fields = Object.getOwnPropertyDescriptors(result);
        if (Reflect.ownKeys(fields).length !== 2 || !fields.statementHex?.enumerable || !fields.signatureHex?.enumerable ||
            !("value" in fields.statementHex) || !("value" in fields.signatureHex)) throw refused();
        const statement = fields.statementHex.value as unknown, signature = fields.signatureHex.value as unknown;
        if (typeof statement !== "string" || statement.length !== REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES * 2 ||
            !/^[0-9a-f]+$/u.test(statement) || typeof signature !== "string" || !/^[0-9a-f]{128}$/u.test(signature)) throw refused();
        const bytes = Buffer.from(statement, "hex");
        const candidateInstance = controllerInstanceHex ?? bytes.subarray(44, 76).toString("hex");
        const expected = Buffer.from(encodeRemoteWorkerControllerAttestation({
          keySha256: authority.keySha256, controllerInstanceHex: candidateInstance,
          authoritySha256: authority.authoritySha256, installationNonce: authority.installationNonce,
          requestSha256: authority.requestSha256, challengeNonceHex: nonce, ordinal: sequence, window,
        }));
        if (!timingSafeEqual(bytes, expected) || !verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "hex"))) throw refused();
        await awaitControllerAuthority(() => assertEnrollmentCurrent(signal), signal);
        signal.throwIfAborted();
        controllerInstanceHex = candidateInstance;
      } catch {
        throw fail();
      } finally { active = false; }
    },
  });
}

export async function awaitControllerAuthority<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(refused());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), cancelled]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", abort); }
}
