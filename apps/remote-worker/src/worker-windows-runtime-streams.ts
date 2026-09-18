import { normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerCellProvisioningExchange,
  readRemoteWorkerCellMountedWorkspaceCheckpoint, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";

export interface WindowsRuntimeStreamFrame {
  readonly sequence: number;
  readonly total: number;
  readonly eof: boolean;
  readonly bytes: Buffer;
}
export interface WindowsRuntimeParentStreamState {
  readonly inputEnded: boolean;
  readonly outputEnded: boolean;
  readonly inputBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}
export interface WindowsRuntimeStreamsOwner {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly authorizePeer: (signal: AbortSignal) => Promise<void>;
  /** Poll without waiting for future input. null means idle; "eof" ends input.
   * No returned bytes may exceed maxBytes, including when the limit is zero. */
  readonly readInput: (maxBytes: number, signal: AbortSignal) => Promise<Uint8Array | "eof" | null>;
  readonly authorizeInput: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    frame: WindowsRuntimeStreamFrame, signal: AbortSignal) => Promise<void>;
  /** Apply normal sanitization before diagnostic persistence. Resolving means
   * this exact ephemeral frame was consumed, not that the job/effect succeeded. */
  readonly consumeOutput: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    stream: "stdout" | "stderr", frame: WindowsRuntimeStreamFrame, signal: AbortSignal) => Promise<void>;
  /** Exclusive authenticated transport owner; obey cancellation before write. */
  readonly reply: (kind: 33 | 34, bytes: Buffer, signal: AbortSignal) => Promise<void>;
}
const refused = () => new Error("Native stream forwarding was interrupted or did not match the protected request; do not replay the workload.");

/** Dispatcher component for native input polls and output frames. The caller
 * authenticates the pipe and serializes this with authority/retention handling.
 * It must close that connection after failure; no adapter retries a frame. */
export class WindowsRuntimeParentStreams {
  private readonly expected: RemoteWorkerRuntimeResultExpectation;
  private readonly history: RemoteWorkerCellProvisioningExchange;
  private readonly owner: WindowsRuntimeStreamsOwner;
  private readonly expires: number;
  private readonly stop = new AbortController();
  private failure: Error | undefined;
  private busy = false;
  private checkingInput = false;
  private issuedInput: { readonly kind: number; readonly bytes: Buffer } | undefined;
  private polls = 0;
  private readonly sequences = [0, 0, 0];
  private readonly totals = [0, 0, 0];
  private readonly ended = [false, false, false];
  public get state(): WindowsRuntimeParentStreamState {
    return Object.freeze({ inputEnded: !this.failure && this.ended[0]!, outputEnded: !this.failure && this.ended[1]! && this.ended[2]!,
      inputBytes: this.totals[0]!, stdoutBytes: this.totals[1]!, stderrBytes: this.totals[2]! });
  }

  public constructor(expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange, owner: WindowsRuntimeStreamsOwner) {
    this.expected = normalizeRemoteWorkerRuntimeResultExpectation(expected);
    this.history = normalizeRemoteWorkerCellProvisioningExchange(history);
    this.owner = Object.freeze({ ...owner });
    if (!Number.isSafeInteger(owner.timeoutMs) || owner.timeoutMs < 1 || owner.timeoutMs > 86400000 || !owner.signal ||
        [owner.authorizePeer, owner.readInput, owner.authorizeInput, owner.consumeOutput, owner.reply].some(fn => typeof fn !== "function") ||
        this.history.mountedWorkspaceRecords?.length !== 2) throw refused();
    const head = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(this.history), this.history.mountedWorkspaceRecords[1]);
    if (head.recordSha256 !== this.expected.checkpointSha256) throw refused();
    this.expires = performance.now() + owner.timeoutMs;
  }

  public async respond(kind: number, supplied: Uint8Array): Promise<void> {
    if (this.failure || this.busy) throw this.fail(); this.busy = true;
    const deadline = Math.min(this.expires, performance.now() + 5000), abort = () => { this.fail(); };
    this.owner.signal.addEventListener("abort", abort, { once: true });
    try {
      this.check(deadline);
      if (!(supplied instanceof Uint8Array) || ![24, 25, 26, 27, 32].includes(kind) || supplied.byteLength !== (kind === 32 ? 88 : 1056)) throw this.fail();
      const bytes = Buffer.from(supplied);
      if (bytes.subarray(0, 32).toString("hex") !== this.expected.nonce || bytes.subarray(32, 64).toString("hex") !== this.expected.requestSha256) throw this.fail();
      if (kind === 32) await this.input(bytes, deadline); else await this.output(kind, bytes, deadline);
    } catch { throw this.fail(); }
    finally { this.owner.signal.removeEventListener("abort", abort); this.busy = false; }
  }

  /** Dedicated authenticated control owner only. Re-check the last issued
   * frame without polling the source, advancing input or writing a stream ACK.
   * A queue retry needs fresh canonical permission for these same exact bytes.
   * Output may continue on the independent stream while this check is pending. */
  public async reauthorizeInput(kind: number, supplied: Uint8Array, signal: AbortSignal): Promise<void> {
    if (this.failure || this.checkingInput) throw this.fail(); this.checkingInput = true;
    const deadline = Math.min(this.expires, performance.now() + 5000), interrupted = () => { this.fail(); };
    this.owner.signal.addEventListener("abort", interrupted, { once: true });
    signal.addEventListener("abort", interrupted, { once: true });
    try {
      this.check(deadline);
      if (signal.aborted || (kind !== 21 && kind !== 22) || !(supplied instanceof Uint8Array) || supplied.byteLength !== 1056) throw this.fail();
      const bytes = Buffer.from(supplied), issued = this.issuedInput;
      if (!issued || issued.kind !== kind || !issued.bytes.equals(bytes)) throw this.fail();
      const data = Buffer.from(bytes.subarray(80, 80 + bytes.readUInt32LE(68)));
      const frame = Object.freeze({ sequence: bytes.readUInt32LE(64), total: Number(bytes.readBigUInt64LE(72)), eof: kind === 22, bytes: Buffer.from(data) });
      await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
      await this.within(deadline, () => this.owner.authorizeInput(this.expected, this.history, frame, this.stop.signal));
      if (!frame.bytes.equals(data) || this.issuedInput !== issued) throw this.fail();
      await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
      if (signal.aborted || this.issuedInput !== issued) throw this.fail();
    } catch { throw this.fail(); }
    finally {
      signal.removeEventListener("abort", interrupted); this.owner.signal.removeEventListener("abort", interrupted); this.checkingInput = false;
    }
  }

  private async input(poll: Buffer, deadline: number): Promise<void> {
    const sequence = this.sequences[0]! + 1;
    if (this.checkingInput || this.ended[0] || sequence > 0xffffffff || this.polls === 0xffffffff || poll.readUInt32LE(64) !== sequence || poll.readUInt32LE(68) !== 0 ||
        poll.readBigUInt64LE(72) !== BigInt(this.totals[0]!) || poll.readUInt32LE(80) !== this.polls + 1 || poll.readUInt32LE(84) !== 0) throw this.fail();
    this.polls += 1;
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
    const maximum = Math.min(976, this.expected.maxInputBytes - this.totals[0]!);
    const source = await this.within(deadline, () => this.owner.readInput(maximum, this.stop.signal));
    const reply = Buffer.alloc(1148); poll.copy(reply);
    if (source !== null) {
      const eof = source === "eof";
      if (!eof && (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > maximum)) throw this.fail();
      const data = eof ? Buffer.alloc(0) : Buffer.from(source as Uint8Array), total = this.totals[0]! + data.length;
      const frame = Object.freeze({ sequence, total, eof, bytes: Buffer.from(data) });
      await this.within(deadline, () => this.owner.authorizeInput(this.expected, this.history, frame, this.stop.signal));
      if (!frame.bytes.equals(data)) throw this.fail();
      reply.writeUInt32LE(eof ? 2 : 1, 88); poll.copy(reply, 92, 0, 64);
      reply.writeUInt32LE(sequence, 156); reply.writeUInt32LE(data.length, 160); reply.writeBigUInt64LE(BigInt(total), 164); data.copy(reply, 172);
      this.sequences[0] = sequence; this.totals[0] = total; this.ended[0] = eof;
    }
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
    // Publish the exact frame when handing it to the exclusive transport. A
    // fast peer may request control before that asynchronous write resolves.
    // An uncertain write fences both paths through the shared failure state.
    if (source !== null) this.issuedInput = { kind: source === "eof" ? 22 : 21, bytes: Buffer.from(reply.subarray(92)) };
    await this.within(deadline, () => this.owner.reply(33, reply, this.stop.signal));
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
  }

  private async output(kind: number, bytes: Buffer, deadline: number): Promise<void> {
    const index = kind < 26 ? 1 : 2, eof = kind === 25 || kind === 27;
    const sequence = bytes.readUInt32LE(64), count = bytes.readUInt32LE(68), totalBig = bytes.readBigUInt64LE(72);
    if (this.ended[index] || this.sequences[index] === 0xffffffff || sequence !== this.sequences[index]! + 1 || count > 976 ||
        (eof ? count !== 0 : count === 0) || totalBig !== BigInt(this.totals[index]! + count) ||
        totalBig + BigInt(this.totals[index === 1 ? 2 : 1]!) > BigInt(this.expected.maxOutputBytes) || bytes.subarray(80 + count).some(b => b !== 0)) throw this.fail();
    const total = Number(totalBig), frame = Object.freeze({ sequence, total, eof, bytes: Buffer.from(bytes.subarray(80, 80 + count)) });
    const reply = Buffer.alloc(84); reply.writeUInt32LE(kind); bytes.copy(reply, 4, 0, 80);
    this.sequences[index] = sequence; this.totals[index] = total; this.ended[index] = eof;
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
    await this.within(deadline, () => this.owner.consumeOutput(this.expected, this.history, index === 1 ? "stdout" : "stderr", frame, this.stop.signal));
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
    await this.within(deadline, () => this.owner.reply(34, reply, this.stop.signal));
    await this.within(deadline, () => this.owner.authorizePeer(this.stop.signal));
  }
  private fail(): Error { this.failure ??= refused(); if (!this.stop.signal.aborted) this.stop.abort(); return this.failure; }
  private check(deadline: number): void { if (this.failure || this.owner.signal.aborted || performance.now() >= deadline) throw this.fail(); }
  private async within<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
    this.check(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.check(deadline); return operation(); }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(this.fail()); this.stop.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(this.fail()), Math.max(1, Math.ceil(deadline - performance.now())));
      })]);
      this.check(deadline); return value;
    } finally { if (timer) clearTimeout(timer); if (abort) this.stop.signal.removeEventListener("abort", abort); }
  }
}
