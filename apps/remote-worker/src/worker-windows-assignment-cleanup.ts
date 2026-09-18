import type { Duplex } from "node:stream";
import { canonicalJsonString, decodeRemoteWorkerRuntimeInstallRequest, encodeRemoteWorkerRuntimeInstallRequest, normalizeRemoteWorkerRuntimeInstallSelection,
  remoteWorkerRuntimeInstallRequestSha256 } from "@goatcitadel/contracts";
import type { WindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
import { readWorkerRuntimeCleanup } from "./worker-runtime-cleanup-client.js";
import { selectWorkerRuntimeInstallation } from "./worker-runtime-install-client.js";
import { WindowsRuntimeCleanupSender } from "./worker-windows-runtime-cleanup.js";
import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";

export interface WindowsAssignmentCleanupBinding {
  readonly challenge: string;
  readonly setSha256: string;
  /** Complete retained installation set for this assignment (currently zero or
   * one). The receiver must reconcile even an empty set against local attempts. */
  readonly installations: readonly Readonly<{ nonce: string; requestSha256: string; requestHex: string }>[];
}
/** GCCADM01 is admission metadata for the already authenticated primary
 * controller connection, never a self-authorizing cleanup data frame. */
export function encodeWindowsAssignmentCleanupAdmission(binding: WindowsAssignmentCleanupBinding): Buffer {
  const { challenge, setSha256, installations } = binding;
  const hash = (value: string) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0+$/u.test(value);
  if (!hash(challenge) || !hash(setSha256) || !Array.isArray(installations) || installations.length > 1)
    throw new Error("Native cleanup admission is invalid.");
  const bytes = Buffer.alloc(80 + installations.length * 336);
  bytes.write("GCCADM01", "ascii"); Buffer.from(challenge, "hex").copy(bytes, 8); Buffer.from(setSha256, "hex").copy(bytes, 40);
  bytes.writeUInt32LE(installations.length, 72);
  if (installations.length) {
    const item = installations[0];
    if (!item || !hash(item.nonce) || !hash(item.requestSha256) || typeof item.requestHex !== "string" || !/^[0-9a-f]{544}$/u.test(item.requestHex))
      throw new Error("Native cleanup installation admission is invalid.");
    const request = Buffer.from(item.requestHex, "hex");
    decodeRemoteWorkerRuntimeInstallRequest(request, { nonce: item.nonce, requestSha256: item.requestSha256 });
    Buffer.from(item.nonce, "hex").copy(bytes, 80); Buffer.from(item.requestSha256, "hex").copy(bytes, 112); request.copy(bytes, 144);
  }
  return bytes;
}
export interface WindowsAssignmentCleanupPeer {
  /** Total handoff budget, including lease admission, lookup and binding. */
  readonly timeoutMs: number;
  readonly authorizePeer: (signal: AbortSignal) => Promise<void>;
  /** Supply the exact binding to the native receiver through its independent
   * protected admission channel, not the cleanup data stream being sent.
   * Callbacks must honor cancellation and join their own I/O before settling. */
  readonly bindReceiver: (binding: WindowsAssignmentCleanupBinding & { readonly admissionHex: string }, signal: AbortSignal) => Promise<void>;
}
/** Caller owns the stable lease and any writer pause for the entire use of this
 * result. Reads never reacquire or renew that lease, nor perform installation.
 * A measurement caller also supplies its exact retained provisioning history. */
export async function readWindowsAssignmentCleanupOnLease(input: {
  readonly context: RouteContext;
  readonly lease: LeaseBinding;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly expectedHistory?: RemoteWorkerCellProvisioningExchange;
}) {
  const { context, signal, assertCurrent } = input;
  const lease = Object.freeze({ ...input.lease });
  const expectedHistory = input.expectedHistory === undefined ? undefined : canonicalJsonString(input.expectedHistory);
  const check = async () => { signal.throwIfAborted(); await assertCurrent(); signal.throwIfAborted(); };
  await check();
  const exchange = await readWorkerRuntimeCleanup(context, lease, signal);
  await check();
  if (expectedHistory !== undefined && canonicalJsonString(exchange.history) !== expectedHistory)
    throw new Error("Runtime cleanup history differs from the retained measurement history.");
  const installation = normalizeRemoteWorkerRuntimeInstallSelection(await selectWorkerRuntimeInstallation(context, lease, signal));
  await check();
  if (canonicalJsonString(installation.history) !== canonicalJsonString(exchange.history))
    throw new Error("Installation and runtime cleanup histories differ under the retained lease.");
  const request = installation.request;
  const installations = Object.freeze(request ? [Object.freeze({ nonce: request.nonce,
    requestSha256: remoteWorkerRuntimeInstallRequestSha256(request),
    requestHex: Buffer.from(encodeRemoteWorkerRuntimeInstallRequest(request)).toString("hex") })] : []);
  return { exchange, installations };
}
/** Hold the canonical lease through lookup, independent receiver binding and
 * delivery. This does not open/admit a peer or prove local writer quiescence. */
export async function sendWindowsAssignmentCleanup(channel: Duplex, authority: WindowsWorkerAssignmentAuthority, peer: WindowsAssignmentCleanupPeer) {
  const owner = Object.freeze({ ...peer });
  if (!Number.isSafeInteger(owner.timeoutMs) || owner.timeoutMs < 1 || owner.timeoutMs > 60000)
    throw new Error("Native cleanup handoff lifetime is invalid.");
  const stop = new AbortController(), signal = AbortSignal.any([authority.signal, stop.signal]);
  const deadline = performance.now() + owner.timeoutMs;
  const expire = () => stop.abort(new Error("Native cleanup handoff deadline expired."));
  const timer = setTimeout(expire, owner.timeoutMs);
  const current = () => {
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
  };
  try {
    current();
    const result = await authority.withStableLease(async (lease, check) => {
      const checkCurrent = async () => { current(); await check(); current(); };
      const { exchange, installations } = await readWindowsAssignmentCleanupOnLease({
        context: authority.context, lease, signal, assertCurrent: checkCurrent });
      let checking: Promise<void> | undefined;
      const sender = new WindowsRuntimeCleanupSender(channel, exchange, { signal, deadline, timeoutMs: owner.timeoutMs,
        authorize: transferSignal => checking = (async () => {
          current(); transferSignal.throwIfAborted(); await owner.authorizePeer(transferSignal);
          await checkCurrent(); transferSignal.throwIfAborted();
        })() });
      current(); await owner.authorizePeer(signal); await checkCurrent();
      const binding = Object.freeze({ ...sender.binding, installations });
      await owner.bindReceiver(Object.freeze({ ...binding, admissionHex: encodeWindowsAssignmentCleanupAdmission(binding).toString("hex") }), signal);
      await checkCurrent();
      // The sender can cancel its wait before an authorization callback joins.
      // Keep the binding stable until that exact callback has settled as well.
      try { return await sender.send(); }
      finally { await checking?.catch(() => undefined); }
    });
    current(); return result;
  } finally {
    // Do not race callbacks against cancellation: the stable lease must stay
    // held until their I/O joins, even after this deadline has refused success.
    clearTimeout(timer); stop.abort();
  }
}
