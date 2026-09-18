import { REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES, REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS } from "@goatcitadel/contracts";

export interface WorkerControllerAttestationTransport {
  readonly signal: AbortSignal;
  challenge(nonceHex: string, ordinal: number, signal: AbortSignal): Promise<{ statementHex: string; signatureHex: string }>;
}
const refused = () => new Error("Controller attestation relay is outside its current native exchange.");

/** Byte relay only: the Gateway verifies the independently enrolled key and
 * signed state. A worker response never establishes enrollment or authority. */
export function createWorkerControllerAttestationRelay(
  write: (frame: Buffer) => Promise<void>, lifetime: AbortSignal, assertCurrent: () => Promise<void>,
) {
  const stop = new AbortController(), signal = AbortSignal.any([lifetime, stop.signal]);
  let ordinal = 0, busy = false;
  let pending: { nonce: string; ordinal: number; resolve(value: Buffer): void } | undefined;
  const close = () => { stop.abort(refused()); pending = undefined; };
  const transport: WorkerControllerAttestationTransport = Object.freeze({ signal,
    async challenge(nonceHex: string, sequence: number, callerSignal: AbortSignal) {
      if (busy || signal.aborted || callerSignal.aborted || !/^[0-9a-f]{64}$/u.test(nonceHex) || /^0+$/u.test(nonceHex) ||
          sequence !== ordinal + 1 || sequence > REMOTE_WORKER_CONTROLLER_ATTESTATION_MAX_CHECKS) { close(); throw refused(); }
      busy = true;
      const current = AbortSignal.any([signal, callerSignal, AbortSignal.timeout(5000)]);
      let cancel = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(refused()); current.addEventListener("abort", cancel, { once: true });
      });
      const bounded = async <T>(operation: () => Promise<T>) => {
        current.throwIfAborted();
        const result = await Promise.race([Promise.resolve().then(() => { current.throwIfAborted(); return operation(); }), cancelled]);
        current.throwIfAborted(); return result;
      };
      try {
        await bounded(assertCurrent);
        const reply = new Promise<Buffer>(resolve => { pending = { nonce: nonceHex, ordinal: sequence, resolve }; });
        const frame = Buffer.alloc(41); frame[0] = 20; frame.writeUInt32LE(36, 1);
        Buffer.from(nonceHex, "hex").copy(frame, 5); frame.writeUInt32LE(sequence, 37);
        await bounded(() => write(frame));
        const proof = await bounded(() => reply);
        await bounded(assertCurrent);
        ordinal = sequence;
        return Object.freeze({ statementHex: proof.subarray(0, REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES).toString("hex"),
          signatureHex: proof.subarray(REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES).toString("hex") });
      } catch { close(); throw refused(); }
      finally { busy = false; pending = undefined; current.removeEventListener("abort", cancel); }
    },
  });
  return Object.freeze({ transport, close,
    /** Called directly by the bounded stdout parser, never queued behind the
     * capture callback that is waiting for this response. */
    accept(input: Uint8Array): void {
      if (signal.aborted || !pending || !(input instanceof Uint8Array) || input.byteLength !== REMOTE_WORKER_CONTROLLER_ATTESTATION_BYTES + 64) {
        close(); throw refused();
      }
      const proof = Buffer.from(input), request = pending;
      if (proof.subarray(0, 8).toString("ascii") !== "GCCATT01" || proof.readUInt32LE(8) !== request.ordinal ||
          proof.subarray(108, 140).toString("hex") !== request.nonce) { close(); throw refused(); }
      pending = undefined; request.resolve(proof);
    },
  });
}
