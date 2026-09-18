import {
  assertRemoteWorkerInstallCapacityChallenge, captureRemoteWorkerNativePoolCapacityResponse,
  hashRemoteWorkerInstallCapacityCapture, normalizeRemoteWorkerInstallCapacityBinding,
  normalizeRemoteWorkerNativeCapacityLayout, normalizeRemoteWorkerNativePoolSnapshot,
  REMOTE_WORKER_INSTALL_CAPACITY_MAXIMUM_CHECKS, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES,
  type RemoteWorkerInstallCapacityBinding, type RemoteWorkerNativePoolCapacityDelivery,
} from "@goatcitadel/contracts";
import type { WindowsWorkerPoolCapacityRequest } from "./worker-windows-cell-provisioning.js";
import type { WorkerControllerAttestationTransport } from "./worker-controller-attestation-relay.js";

/** Borrowed from the enclosing registered Gateway session. Capture must retain
 * canonical reservation ownership through helper termination; a successful
 * callback or cached digest does not replace that lifetime. */
export interface WindowsWorkerInstallationCaptureAdmission {
  connected(connectionNonceHex: string, signal: AbortSignal, controller?: WorkerControllerAttestationTransport): Promise<void>;
  capture(responseHex: string, binding: RemoteWorkerInstallCapacityBinding,
    delivery: RemoteWorkerNativePoolCapacityDelivery, signal: AbortSignal): Promise<void>;
  verify(challenge: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Recheck live authority, then invoke join exactly once to permit native
   * finish. Await join before releasing the canonical reservation. */
  finish(join: () => Promise<void>, signal: AbortSignal): Promise<void>;
}
const refused = () => new Error("Installation capture differs from its retained native session.");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0+$/u.test(value);

export function createWindowsInstallationCapture(
  selection: { readonly nonce: string; readonly requestSha256: string }, supplied: WindowsWorkerPoolCapacityRequest,
  suppliedOwner: Pick<WindowsWorkerInstallationCaptureAdmission, "connected" | "capture" | "verify">,
  assertCurrent: () => Promise<void>, signal: AbortSignal,
  controller?: WorkerControllerAttestationTransport,
) {
  const nonce = selection.nonce, requestSha256 = selection.requestSha256;
  const pool = normalizeRemoteWorkerNativePoolSnapshot(supplied.pool), layout = normalizeRemoteWorkerNativeCapacityLayout(supplied.layout);
  const captureNonce = supplied.captureNonce, referencesJson = supplied.referencesJson;
  const owner = Object.freeze({ ...suppliedOwner });
  if (!digest(nonce) || !digest(requestSha256) || !digest(captureNonce) || typeof referencesJson !== "string" ||
      Buffer.byteLength(referencesJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES ||
      ![owner.connected, owner.capture, owner.verify, assertCurrent].every(value => typeof value === "function")) throw refused();
  const references: unknown = JSON.parse(referencesJson);
  if (!Array.isArray(references) || references.length > 20000) throw refused();
  const ids = new Set<string>();
  for (const reference of references) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).length !== 2 ||
        !digest(reference.referenceSha256) || !digest(reference.objectIdentitySha256) || ids.has(reference.referenceSha256)) throw refused();
    ids.add(reference.referenceSha256);
  }
  let phase: "new" | "connected" | "header" | "captured" = "new";
  let connection = "", ordinal = 0, busy = false, closed = false;
  let binding: RemoteWorkerInstallCapacityBinding | undefined;
  const control = () => { signal.throwIfAborted(); if (closed) throw refused(); };
  const wait = async (operation: () => Promise<void>) => {
    control();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(refused()); signal.addEventListener("abort", abort, { once: true }); });
    try { await Promise.race([Promise.resolve().then(() => { control(); return operation(); }), cancelled]); control(); }
    finally { signal.removeEventListener("abort", abort); }
  };
  return Object.freeze({
    async accept(kind: number, input: Uint8Array): Promise<Buffer | undefined> {
      if (busy || closed) { closed = true; throw refused(); }
      busy = true;
      try {
        control();
        if (!(input instanceof Uint8Array) || input.byteLength > REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES) throw refused();
        const payload = Buffer.from(input);
        await wait(assertCurrent);
        if (kind === 15) {
          if (phase !== "new" || payload.length !== 32 || !digest(payload.toString("hex"))) throw refused();
          connection = payload.toString("hex");
          await wait(() => controller ? owner.connected(connection, signal, controller) : owner.connected(connection, signal)); phase = "connected"; return;
        }
        if (kind === 16) {
          if (phase !== "connected" || payload.length !== 144) throw refused();
          const selected = normalizeRemoteWorkerInstallCapacityBinding({ connectionNonceHex: connection, installationNonce: nonce,
            requestSha256, captureSha256: payload.subarray(96, 128).toString("hex"), byteLength: payload.readUInt32LE(136) });
          if (selected.byteLength < 1312) throw refused();
          assertRemoteWorkerInstallCapacityChallenge(payload, selected, 1);
          binding = selected; phase = "header"; return;
        }
        if (kind === 17) {
          if (phase !== "header" || !binding || payload.length !== binding.byteLength ||
              hashRemoteWorkerInstallCapacityCapture(payload) !== binding.captureSha256) throw refused();
          const responseHex = payload.toString("hex");
          const delivery = captureRemoteWorkerNativePoolCapacityResponse(responseHex, pool, layout, captureNonce, references);
          if (delivery.window.connectionNonceHex !== connection) throw refused();
          await wait(() => owner.capture(responseHex, binding!, delivery, signal)); phase = "captured"; return;
        }
        if (kind === 18) {
          if (phase !== "captured" || !binding || ordinal >= REMOTE_WORKER_INSTALL_CAPACITY_MAXIMUM_CHECKS) throw refused();
          assertRemoteWorkerInstallCapacityChallenge(payload, binding, ordinal + 1);
          await wait(() => owner.verify(Uint8Array.from(payload), signal));
          await wait(assertCurrent);
          ++ordinal;
          const acknowledgement = Buffer.alloc(149); acknowledgement[0] = 19; acknowledgement.writeUInt32LE(144, 1);
          payload.copy(acknowledgement, 5); return acknowledgement;
        }
        throw refused();
      } catch (error) { closed = true; throw error; }
      finally { busy = false; }
    },
    assertComplete(): void { control(); if (busy || phase !== "captured" || ordinal < 1) throw refused(); },
    close(): void { closed = true; },
  });
}
