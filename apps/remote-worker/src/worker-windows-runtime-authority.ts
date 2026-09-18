import { normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerCellProvisioningExchange,
  readRemoteWorkerCellMountedWorkspaceCheckpoint, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";

export interface WindowsRuntimeAuthorityOwner {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Current protected-parent custody; this does not grant execution or delivery. */
  readonly authorizePeer: (signal: AbortSignal) => Promise<void>;
  /** Consult canonical assignment, lease and request-specific grants every time. */
  readonly authorizeRuntime: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    ordinal: number, signal: AbortSignal) => Promise<void>;
  readonly authorizeDelivery: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    ordinal: number, signal: AbortSignal) => Promise<void>;
  /** The exclusive authenticated pipe owner must honor cancellation and finish
   * this write before resolving. Never enqueue an unbounded deferred reply. */
  readonly reply: (kind: 20 | 31, payload: Buffer, signal: AbortSignal) => Promise<void>;
}
const refused = () => new Error("Native runtime authority is stale, interrupted, or does not match the protected request.");

/** Handles complete 104-byte native challenges from the exclusive protected
 * pipe dispatcher. This adapter neither opens/authenticates a pipe nor creates
 * an execution grant. Runtime and delivery are different canonical decisions. */
export class WindowsRuntimeParentAuthority {
  private readonly expected: RemoteWorkerRuntimeResultExpectation;
  private readonly history: RemoteWorkerCellProvisioningExchange;
  private readonly owner: WindowsRuntimeAuthorityOwner;
  private readonly expires: number;
  private readonly stop = new AbortController();
  private failure: Error | undefined;
  private busy = false;
  private runtimeOrdinal = 0;
  private deliveryOrdinal = 0;

  public constructor(expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    owner: WindowsRuntimeAuthorityOwner) {
    this.expected = normalizeRemoteWorkerRuntimeResultExpectation(expected);
    this.history = normalizeRemoteWorkerCellProvisioningExchange(history);
    this.owner = Object.freeze({ ...owner });
    if (!Number.isSafeInteger(owner.timeoutMs) || owner.timeoutMs < 1 || owner.timeoutMs > 86400000 ||
        !owner.signal || [owner.authorizePeer, owner.authorizeRuntime, owner.authorizeDelivery, owner.reply].some(fn => typeof fn !== "function") ||
        this.history.mountedWorkspaceRecords?.length !== 2) throw refused();
    const head = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(this.history),
      this.history.mountedWorkspaceRecords[1]);
    if (head.recordSha256 !== this.expected.checkpointSha256) throw refused();
    this.expires = performance.now() + owner.timeoutMs;
  }

  public async respond(kind: number, supplied: Uint8Array): Promise<void> {
    if (this.failure || this.busy) throw this.fail();
    this.busy = true;
    const deadline = Math.min(this.expires, performance.now() + 5000);
    const interrupted = () => { this.fail(); };
    this.owner.signal.addEventListener("abort", interrupted, { once: true });
    try {
      this.check(deadline);
      if ((kind !== 19 && kind !== 30) || !(supplied instanceof Uint8Array) || supplied.byteLength !== 104) throw this.fail();
      const challenge = Buffer.from(supplied), delivery = kind === 30;
      const ordinal = (delivery ? this.deliveryOrdinal : this.runtimeOrdinal) + 1;
      if (ordinal > 0xffffffff || challenge.readUInt32LE(32) !== ordinal || challenge.readUInt32LE(36) !== 21 ||
          challenge.subarray(0, 32).toString("hex") !== this.expected.nonce ||
          challenge.subarray(40, 72).toString("hex") !== this.expected.checkpointSha256 ||
          challenge.subarray(72, 104).toString("hex") !== this.expected.requestSha256) throw this.fail();
      if (delivery) this.deliveryOrdinal = ordinal; else this.runtimeOrdinal = ordinal;
      await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
      await this.within(deadline, () => (delivery ? this.owner.authorizeDelivery : this.owner.authorizeRuntime)(
        this.expected, this.history, ordinal, this.stop.signal));
      await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
      await this.within(deadline, () => this.owner.reply(delivery ? 31 : 20, challenge, this.stop.signal));
      await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
    } catch { throw this.fail(); }
    finally { this.owner.signal.removeEventListener("abort", interrupted); this.busy = false; }
  }

  private fail(): Error {
    this.failure ??= refused();
    if (!this.stop.signal.aborted) this.stop.abort();
    return this.failure;
  }
  private check(deadline: number): void {
    if (this.failure || this.owner.signal.aborted || performance.now() >= deadline) throw this.fail();
  }
  private async within(deadline: number, operation: () => Promise<void>): Promise<void> {
    this.check(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => { this.check(deadline); return operation(); }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(this.fail());
        this.stop.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(this.fail()), Math.max(1, Math.ceil(deadline - performance.now())));
      })]);
      this.check(deadline);
    } finally { if (timer) clearTimeout(timer); if (abort) this.stop.signal.removeEventListener("abort", abort); }
  }
}
