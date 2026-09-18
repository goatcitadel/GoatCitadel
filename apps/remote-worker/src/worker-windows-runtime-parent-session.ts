import type { Duplex } from "node:stream";
import { canonicalJsonString, normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerNativeFileStaging, readRemoteWorkerRuntimeResult, readRemoteWorkerNativeFileAuthorization, REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES,
  type RemoteWorkerNativeFileStaging,
  type RemoteWorkerNativeFileExportSelection,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange, type RemoteWorkerRuntimeResultReceipt } from "@goatcitadel/contracts";
import { WindowsRuntimeParentAuthority, type WindowsRuntimeAuthorityOwner } from "./worker-windows-runtime-authority.js";
import { WindowsRuntimeParentStreams, type WindowsRuntimeStreamsOwner } from "./worker-windows-runtime-streams.js";
import { WindowsRuntimeResultRetentionParent, type WindowsRuntimeRetentionOwner } from "./worker-windows-runtime-retention.js";
import type { RouteContext, LeaseBinding } from "./connected-worker-routes.js";
import { uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { WindowsRuntimeFileBatchReceiver, type WindowsRuntimeReceivedFile } from "./worker-windows-runtime-files.js";

export interface WindowsRuntimeParentSessionOwner extends Omit<WindowsRuntimeAuthorityOwner, "reply">,
  Omit<WindowsRuntimeStreamsOwner, "reply"> {
  readonly authorizeRetention: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange, signal: AbortSignal) => Promise<void>;
  readonly retain: WindowsRuntimeRetentionOwner["retain"];
  readonly authorizeFile?: (expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
    selection: RemoteWorkerNativeFileExportSelection, signal: AbortSignal) => Promise<void>;
  /** Must be copied from the independently admitted request by its owner. */
  readonly fileStaging?: RemoteWorkerNativeFileStaging;
  /** The provisioning owner invokes this only after the exact helper exits
   * cleanly and its outer receipt and current custody have been validated. */
  readonly consumeFiles?: (files: readonly WindowsRuntimeReceivedFile[], signal: AbortSignal) => Promise<void>;
}
export interface WindowsRuntimeGatewayLeaseOwner {
  withCurrentLease<T>(operation: (lease: LeaseBinding) => Promise<T>): Promise<T>;
}

/** Production result storage composition; credentials remain in the protected
 * route context, and input/runtime grants still come from canonical owners. */
export function createWindowsRuntimeGatewaySession(channel: Duplex, context: RouteContext, lease: LeaseBinding,
  expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
  owner: Omit<WindowsRuntimeParentSessionOwner, "retain">): WindowsRuntimeParentSession {
  return new WindowsRuntimeParentSession(channel, expected, history,
    createWindowsRuntimeGatewayOwner(context, lease, expected, history, owner));
}

/** Shared by direct sessions and the provisioning helper, which owns its own
 * private duplex channel. Result retention always uses the protected route. */
export function createWindowsRuntimeGatewayOwner(context: RouteContext, lease: LeaseBinding,
  expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange,
  owner: Omit<WindowsRuntimeParentSessionOwner, "retain">,
  currentLease?: (signal: AbortSignal) => Promise<LeaseBinding>,
  leaseOwner?: WindowsRuntimeGatewayLeaseOwner): WindowsRuntimeParentSessionOwner {
  const request = normalizeRemoteWorkerRuntimeResultExpectation(expected), retained = normalizeRemoteWorkerCellProvisioningExchange(history);
  const route = Object.freeze({ ...context }), binding = Object.freeze({ ...lease });
  if (binding.registryWorkspaceId !== retained.registryWorkspaceId || binding.assignmentId !== retained.assignmentId ||
      binding.assignmentGeneration !== retained.assignmentGeneration || binding.leaseRevision !== retained.leaseRevision) throw refused();
  const retain = async (hex: string, signal: AbortSignal, heldLease?: LeaseBinding) => {
    signal.throwIfAborted();
    let uploadLease = binding, uploadHistory = retained;
    if (heldLease || currentLease) {
      // Only the installed lease owner supplies this callback. A rotated lease
      // still needs current Gateway history for the original admitted journal.
      uploadLease = Object.freeze({ ...(heldLease ?? await currentLease!(signal)) });
      signal.throwIfAborted();
      if (uploadLease.registryWorkspaceId !== binding.registryWorkspaceId || uploadLease.assignmentId !== binding.assignmentId ||
          uploadLease.assignmentGeneration !== binding.assignmentGeneration || !Number.isSafeInteger(uploadLease.leaseRevision) ||
          uploadLease.leaseRevision < binding.leaseRevision) throw refused();
      uploadHistory = normalizeRemoteWorkerCellProvisioningExchange((await exchangeWorkerCellCapacity(route, uploadLease,
        { kind: "cell.capacity.snapshot" }, signal)).history);
      signal.throwIfAborted();
      if (uploadHistory.leaseRevision !== uploadLease.leaseRevision ||
          canonicalJsonString({ ...uploadHistory, leaseRevision: retained.leaseRevision }) !== canonicalJsonString(retained)) throw refused();
    }
    const result = await uploadWorkerRuntimeResult(route, uploadLease, hex, request, uploadHistory, signal);
    signal.throwIfAborted();
    if (!result.record) throw refused(); return result.record;
  };
  return Object.freeze({ ...owner, retain: (hex: string, signal: AbortSignal) => leaseOwner
    ? leaseOwner.withCurrentLease(binding => retain(hex, signal, binding)) : retain(hex, signal) });
}
const refused = () => new Error("The protected native runtime connection failed; resolve any retained result before retrying delivery.");

/** Exclusive borrowed authenticated pipe owner for the runtime phase. The
 * caller admits the request separately and keeps the pipe alive until both
 * this run and its exact helper process have joined. No endpoint is opened,
 * workload launched, authority invented or reconnect attempted here. */
export class WindowsRuntimeParentSession {
  private readonly expected: RemoteWorkerRuntimeResultExpectation;
  private readonly history: RemoteWorkerCellProvisioningExchange;
  private readonly owner: WindowsRuntimeParentSessionOwner;
  private readonly stop = new AbortController();
  private attempted = false;
  private failure: Error | undefined;
  private deadline = 0;
  private phase: "runtime" | "delivery" | "retaining" | "retained" | "files" | "finished" = "runtime";
  private receipt: RemoteWorkerRuntimeResultReceipt | undefined;
  private retainedResultHex: string | undefined;
  private files: readonly WindowsRuntimeReceivedFile[] | undefined;
  private filesAttempted = false;
  private filesCompleted = false;
  private filesTaken = false;
  private runtimeApproved = false;
  private retentionAttempted = false;
  private retentionConfirmed = false;
  private cleanupVerified = false;
  private streams: WindowsRuntimeParentStreams | undefined;
  private streamsComplete = false;
  private deliveryOrdinal = 0;
  private controlAttempted = false;
  private controlBusy = false;
  private controlTask: Promise<void> | undefined;
  private readonly controlDone = new AbortController();
  private readonly progress = new Set<() => void>();
  public get state() { return Object.freeze({ phase: this.phase, retentionAttempted: this.retentionAttempted,
    retentionConfirmed: this.retentionConfirmed, finished: this.phase === "finished" && !this.failure,
    cleanupVerified: this.cleanupVerified && this.phase === "finished" && !this.failure }); }

  public constructor(private readonly channel: Duplex, expected: RemoteWorkerRuntimeResultExpectation,
    history: RemoteWorkerCellProvisioningExchange, owner: WindowsRuntimeParentSessionOwner) {
    this.expected = normalizeRemoteWorkerRuntimeResultExpectation(expected);
    this.history = normalizeRemoteWorkerCellProvisioningExchange(history);
    this.owner = Object.freeze({ ...owner, ...(owner.fileStaging ? { fileStaging: normalizeRemoteWorkerNativeFileStaging(owner.fileStaging) } : {}) });
  }

  public takeFiles(): readonly WindowsRuntimeReceivedFile[] {
    if (this.failure || this.phase !== "finished" || this.filesTaken || (this.owner.fileStaging && !this.filesCompleted)) throw this.fail();
    this.filesTaken = true; const files = this.files ?? Object.freeze([]); this.files = undefined; return files;
  }
  public discardFiles(): void { for (const file of this.files ?? []) file.record.fill(0); this.files = undefined; }

  public async run(): Promise<RemoteWorkerRuntimeResultReceipt> {
    if (this.attempted) throw this.fail(); this.attempted = true;
    if (!Number.isSafeInteger(this.owner.timeoutMs) || this.owner.timeoutMs < 1 || this.owner.timeoutMs > 86400000 || !this.owner.signal ||
        typeof this.owner.authorizeRetention !== "function" || typeof this.owner.retain !== "function" ||
        (this.owner.fileStaging !== undefined && typeof this.owner.authorizeFile !== "function") ||
        this.channel.readableFlowing === true || this.channel.listenerCount("data") || this.channel.listenerCount("readable")) throw this.fail();
    this.deadline = performance.now() + this.owner.timeoutMs;
    const interrupted = () => { this.fail(); };
    this.owner.signal.addEventListener("abort", interrupted, { once: true });
    this.channel.on("error", interrupted); this.channel.on("close", interrupted); this.channel.on("end", interrupted);
    const watchdog = setTimeout(interrupted, this.owner.timeoutMs);
    try {
      this.check(this.deadline);
      const options = { ...this.owner, signal: this.stop.signal,
        authorizeDelivery: async (_expected: RemoteWorkerRuntimeResultExpectation, _history: RemoteWorkerCellProvisioningExchange,
          _ordinal: number, signal: AbortSignal) => this.authorizeDelivery(signal),
        reply: async (kind: number, bytes: Buffer, signal: AbortSignal) => {
          if (signal.aborted) throw this.fail();
          await this.writeFrame(kind, bytes, Math.min(this.deadline, performance.now() + 5000));
          if (signal.aborted) throw this.fail();
        },
      };
      const authority = new WindowsRuntimeParentAuthority(this.expected, this.history, options);
      const streams = new WindowsRuntimeParentStreams(this.expected, this.history, options);
      this.streams = streams;
      for (;;) {
        // Idle runtime may last the admitted lifetime. Once any byte arrives,
        // a complete bounded control frame must follow within five seconds.
        const first = await this.read(1, this.deadline), frameDeadline = Math.min(this.deadline, performance.now() + 5000);
        const magic = Buffer.concat([first, await this.read(7, frameDeadline)]);
        if (magic.equals(Buffer.from("GCRTS001"))) {
          if (this.phase !== "delivery") throw this.fail();
          const evidence = streams.state;
          if (!this.runtimeApproved || !evidence.inputEnded || !evidence.outputEnded) throw this.fail();
          this.channel.unshift(magic);
          const retention = new WindowsRuntimeResultRetentionParent(this.channel, this.expected, this.history, {
            signal: this.stop.signal, timeoutMs: Math.max(1, Math.min(600000, Math.floor(this.deadline - performance.now()))),
            allowDispatcherContinuation: true,
            dispatcherContinuationMaxBytes: this.owner.fileStaging ? Math.max(120, 108 + 24 * this.owner.fileStaging.paths.length) : 120,
            authorize: async () => {
              await this.owner.authorizePeer(this.stop.signal);
              await this.owner.authorizeRetention(this.expected, this.history, this.stop.signal);
              await this.owner.authorizePeer(this.stop.signal);
            },
            retain: async (hex, signal) => {
              const result = readRemoteWorkerRuntimeResult(hex, this.expected, this.history);
              if (!result.flags.stdinComplete || result.stdinBytes !== evidence.inputBytes || result.stdoutBytes !== evidence.stdoutBytes ||
                  result.stderrBytes !== evidence.stderrBytes) throw this.fail();
              const receipt = await this.owner.retain(hex, signal);
              this.retainedResultHex = hex;
              this.cleanupVerified = result.flags.zeroProcessesVerified && result.flags.outputDrained;
              return receipt;
            },
          });
          this.phase = "retaining";
          try { this.receipt = await retention.run(); }
          finally { this.retentionAttempted = retention.state.retentionAttempted; this.retentionConfirmed = retention.state.retentionConfirmed; }
          this.phase = "retained"; this.notifyProgress(); this.check(this.deadline); continue;
        }
        if (magic.equals(Buffer.from("GCFSL001"))) {
          if (this.phase !== "retained" || !this.retainedResultHex || !this.owner.fileStaging || !this.owner.authorizeFile || this.filesAttempted) throw this.fail();
          this.filesAttempted = true; this.phase = "files"; this.channel.unshift(magic);
          const deadline = Math.min(this.deadline, performance.now() + 600000);
          const receiver = new WindowsRuntimeFileBatchReceiver(this.owner.fileStaging, this.expected, this.retainedResultHex, this.history, {
            signal: this.stop.signal, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
            read: async (count, signal) => { signal.throwIfAborted(); return this.read(count, deadline); },
            write: async (bytes, signal) => {
              signal.throwIfAborted();
              await this.within(deadline, () => new Promise<void>((resolve, reject) => this.channel.write(bytes, error => error ? reject(error) : resolve())));
            },
            authorizePeer: signal => this.owner.authorizePeer(signal),
            authorizeFile: (selection, signal) => this.owner.authorizeFile!(this.expected, this.history, selection, signal),
          });
          this.files = await receiver.run(); this.filesCompleted = receiver.state.completed;
          if (!this.filesCompleted) throw this.fail();
          this.phase = "retained"; this.notifyProgress(); this.check(this.deadline); continue;
        }
        if (!magic.equals(Buffer.from("GCCELL01"))) throw this.fail();
        const header = await this.read(8, frameDeadline), kind = header.readUInt32LE(0), length = header.readUInt32LE(4);
        const expectedLength = kind === 19 || kind === 30 ? 104 : kind === 32 ? 88 : kind >= 24 && kind <= 27 ? 1056 : kind === 35 ? 100 : 0;
        if (!expectedLength || length !== expectedLength) throw this.fail();
        const payload = await this.read(length, frameDeadline);
        if (kind === 35) {
          if (this.phase !== "retained" || !this.receipt || (this.owner.fileStaging && !this.filesCompleted)) throw this.fail();
          while (this.controlBusy) await this.waitForProgress(frameDeadline);
          const finish = Buffer.alloc(100); Buffer.from(this.expected.nonce, "hex").copy(finish);
          Buffer.from(this.expected.requestSha256, "hex").copy(finish, 32); Buffer.from(this.receipt.resultSha256, "hex").copy(finish, 64);
          finish.writeUInt32LE(this.receipt.byteLength, 96);
          if (!payload.equals(finish) || this.channel.readableLength) throw this.fail();
          await this.within(frameDeadline, () => this.owner.authorizePeer(this.stop.signal));
          await this.within(frameDeadline, () => this.owner.authorizeRetention(this.expected, this.history, this.stop.signal));
          await this.writeFrame(36, finish, frameDeadline);
          await this.within(frameDeadline, () => this.owner.authorizePeer(this.stop.signal));
          if (this.channel.readableLength) throw this.fail();
          this.phase = "finished"; return this.receipt;
        }
        if (kind === 30) {
          if (!this.runtimeApproved || !streams.state.inputEnded || !streams.state.outputEnded) throw this.fail();
          if (this.phase === "runtime") this.phase = "delivery";
          await authority.respond(kind, payload);
        } else if (this.phase !== "runtime") throw this.fail();
        else if (kind === 19) { await authority.respond(kind, payload); this.runtimeApproved = true; }
        else {
          if (kind !== 32 && !this.runtimeApproved) throw this.fail();
          await streams.respond(kind, payload);
          this.streamsComplete = streams.state.inputEnded && streams.state.outputEnded;
        }
        this.notifyProgress();
      }
    } catch { throw this.fail(); }
    finally {
      this.controlDone.abort(); this.notifyProgress();
      await this.controlTask?.catch(() => undefined);
      this.retainedResultHex = undefined;
      clearTimeout(watchdog); this.owner.signal.removeEventListener("abort", interrupted);
      this.channel.off("error", interrupted); this.channel.off("close", interrupted); this.channel.off("end", interrupted);
    }
  }

  /** Attach one independently authenticated control pipe after run() starts.
   * The endpoint owner retains both pipes until both tasks settle. No endpoint
   * is opened here and pipe possession never supplies canonical authority. */
  public runControl(control: Duplex): Promise<void> {
    if (this.controlAttempted || !this.attempted || !this.streams || this.failure || this.phase === "finished" || control === this.channel ||
        control.readableFlowing === true || control.listenerCount("data") || control.listenerCount("readable")) return Promise.reject(this.fail());
    this.controlAttempted = true;
    this.controlTask = this.controlLoop(control);
    void this.controlTask.catch(() => undefined);
    return this.controlTask;
  }
  private async controlLoop(control: Duplex): Promise<void> {
    const interrupted = () => { this.fail(); };
    control.on("error", interrupted); control.on("end", interrupted); control.on("close", interrupted);
    let ordinal = 0;
    try {
      for (;;) {
        const first = await this.readControl(control, 1, this.deadline);
        this.controlBusy = true;
        const deadline = Math.min(this.deadline, performance.now() + 5000);
        try {
          const header = Buffer.concat([first, await this.readControl(control, 15, deadline)]);
          if (!header.subarray(0, 8).equals(Buffer.from("GCCELL01")) || header.readUInt32LE(8) !== 37 || header.readUInt32LE(12) !== 1168) throw this.fail();
          const bytes = await this.readControl(control, 1168, deadline);
          if (control.readableLength || ordinal === 0xffffffff || bytes.readUInt32LE(32) !== ordinal + 1 || bytes.readUInt32LE(36) !== 21 ||
              bytes.subarray(0, 32).toString("hex") !== this.expected.nonce || bytes.subarray(40, 72).toString("hex") !== this.expected.checkpointSha256 ||
              bytes.subarray(72, 104).toString("hex") !== this.expected.requestSha256) throw this.fail();
          ordinal += 1;
          const action = bytes.readUInt32LE(104);
          if (action === 1) {
            if (this.phase !== "runtime") throw this.fail();
            await this.controlWithin(control, deadline, () => this.streams!.reauthorizeInput(bytes.readUInt32LE(108), bytes.subarray(112), this.stop.signal));
          } else if (action === 2) {
            if (bytes.subarray(108).some(byte => byte !== 0)) throw this.fail();
            // The other pipe may still be consuming the last output frame.
            // Wait for its actual completed consumer, never infer EOF from this
            // challenge or hold the runtime reader while waiting.
            while (!this.runtimeApproved || !this.streamsComplete) {
              let ready: (() => void) | undefined;
              try { await this.controlWithin(control, deadline, () => new Promise<void>(resolve => {
                ready = resolve; this.progress.add(ready); if (this.runtimeApproved && this.streamsComplete) resolve();
              })); }
              finally { if (ready) this.progress.delete(ready); }
            }
            if (this.phase === "runtime") this.phase = "delivery";
            await this.controlWithin(control, deadline, () => this.owner.authorizePeer(this.stop.signal));
            await this.controlWithin(control, deadline, () => this.authorizeDelivery(this.stop.signal));
            await this.controlWithin(control, deadline, () => this.owner.authorizePeer(this.stop.signal));
          } else if (action === 3) {
            if (!this.owner.authorizeFile) throw this.fail();
            while (this.phase === "retaining") await this.controlWithin(control, deadline, () => this.waitForProgress(deadline));
            if ((this.phase !== "retained" && this.phase !== "files") || !this.retentionConfirmed || !this.retainedResultHex) throw this.fail();
            const selection = readRemoteWorkerNativeFileAuthorization(bytes.subarray(108).toString("hex"),
              this.expected, this.retainedResultHex, this.history);
            if (this.owner.fileStaging && (!this.owner.fileStaging.paths.includes(selection.logicalPath) ||
                selection.maximumBytes !== this.owner.fileStaging.maximumFileBytes)) throw this.fail();
            await this.controlWithin(control, deadline, () => this.owner.authorizePeer(this.stop.signal));
            await this.controlWithin(control, deadline, () => this.owner.authorizeFile!(this.expected, this.history, selection, this.stop.signal));
            await this.controlWithin(control, deadline, () => this.owner.authorizePeer(this.stop.signal));
          } else throw this.fail();
          const reply = Buffer.from(header); reply.writeUInt32LE(38, 8);
          await this.controlWithin(control, deadline, () => new Promise<void>((resolve, reject) =>
            control.write(Buffer.concat([reply, bytes]), error => error ? reject(error) : resolve())));
          await this.controlWithin(control, deadline, () => this.owner.authorizePeer(this.stop.signal));
        } finally { this.controlBusy = false; this.notifyProgress(); }
      }
    } catch {
      if (this.failure || this.phase !== "finished" || !this.controlDone.signal.aborted) throw this.fail();
    } finally {
      control.off("error", interrupted); control.off("end", interrupted); control.off("close", interrupted);
    }
  }
  private async authorizeDelivery(signal: AbortSignal): Promise<void> {
    if (this.deliveryOrdinal === 0xffffffff) throw this.fail();
    await this.owner.authorizeDelivery(this.expected, this.history, ++this.deliveryOrdinal, signal);
  }
  private notifyProgress(): void { for (const ready of this.progress) ready(); this.progress.clear(); }
  private async waitForProgress(deadline: number): Promise<void> {
    let ready: (() => void) | undefined;
    try { await this.within(deadline, () => new Promise<void>(resolve => { ready = resolve; this.progress.add(ready); if (!this.controlBusy) resolve(); })); }
    finally { if (ready) this.progress.delete(ready); }
  }
  private async controlWithin<T>(control: Duplex, deadline: number, work: () => Promise<T>): Promise<T> {
    const check = () => {
      if (this.controlDone.signal.aborted) throw refused();
      this.check(deadline);
      if (control.destroyed || control.readableEnded || control.writableEnded || control.readableLength > 1184) throw this.fail();
    };
    check(); let timer: ReturnType<typeof setTimeout> | undefined, interrupted: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), new Promise<never>((_, reject) => {
        interrupted = () => reject(refused());
        this.stop.signal.addEventListener("abort", interrupted, { once: true });
        this.controlDone.signal.addEventListener("abort", interrupted, { once: true });
        timer = setTimeout(() => reject(this.fail()), Math.max(1, Math.ceil(deadline - performance.now())));
      })]); check(); return value;
    } finally {
      if (timer) clearTimeout(timer);
      if (interrupted) { this.stop.signal.removeEventListener("abort", interrupted); this.controlDone.signal.removeEventListener("abort", interrupted); }
    }
  }
  private async readControl(control: Duplex, count: number, deadline: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < count) {
      await this.controlWithin(control, deadline, async () => {
        const wanted = Math.min(count - received, control.readableLength);
        if (wanted) {
          const bytes: unknown = control.read(wanted);
          if (!Buffer.isBuffer(bytes) || bytes.length !== wanted) throw this.fail();
          parts.push(Buffer.from(bytes)); received += bytes.length; return;
        }
        let ready: (() => void) | undefined;
        try { await this.controlWithin(control, deadline, () => new Promise<void>(resolve => { ready = resolve; control.once("readable", ready); if (control.readableLength) resolve(); })); }
        finally { if (ready) control.off("readable", ready); }
      });
    }
    return Buffer.concat(parts, count);
  }

  private fail(): Error { this.failure ??= refused(); this.discardFiles(); if (!this.stop.signal.aborted) this.stop.abort(); return this.failure; }
  private check(deadline: number): void {
    if (this.failure || this.owner.signal.aborted || this.channel.destroyed || this.channel.readableEnded || this.channel.writableEnded ||
        performance.now() >= deadline || this.channel.readableLength > (this.phase === "delivery" || this.phase === "retaining" ? REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES + 4096 :
          this.phase === "files" ? 1048576 + 200 + 16 * 257 + 112 + 40 : 8192)) throw this.fail();
  }
  private async within<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
    this.check(deadline); let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.check(deadline); return operation(); }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(this.fail()); this.stop.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(this.fail()), Math.max(1, Math.ceil(deadline - performance.now())));
      })]); this.check(deadline); return value;
    } finally { if (timer) clearTimeout(timer); if (abort) this.stop.signal.removeEventListener("abort", abort); }
  }
  private async read(count: number, deadline: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    for (;;) {
      this.check(deadline);
      const wanted = Math.min(count - received, this.channel.readableLength);
      if (wanted) {
        const bytes: unknown = this.channel.read(wanted);
        if (bytes !== null) {
          if (!Buffer.isBuffer(bytes) || bytes.length !== wanted) throw this.fail();
          parts.push(Buffer.from(bytes)); received += bytes.length;
          if (received === count) return Buffer.concat(parts, count); continue;
        }
      }
      let ready: (() => void) | undefined;
      try { await this.within(deadline, () => new Promise<void>(resolve => { ready = resolve; this.channel.once("readable", ready); if (this.channel.readableLength) resolve(); })); }
      finally { if (ready) this.channel.off("readable", ready); }
    }
  }
  private async writeFrame(kind: number, payload: Buffer, deadline: number): Promise<void> {
    const header = Buffer.alloc(16); header.write("GCCELL01"); header.writeUInt32LE(kind, 8); header.writeUInt32LE(payload.length, 12);
    const bytes = Buffer.concat([header, payload]);
    await this.within(deadline, () => new Promise<void>((resolve, reject) => this.channel.write(bytes, error => error ? reject(error) : resolve())));
  }
}
