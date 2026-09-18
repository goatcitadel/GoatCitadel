import type { Duplex } from "node:stream";
import { normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerRuntimeResult,
  REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES, type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange,
  type RemoteWorkerRuntimeResultReceipt } from "@goatcitadel/contracts";
import type { RouteContext, LeaseBinding } from "./connected-worker-routes.js";
import { uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";

export interface WindowsRuntimeRetentionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Current trusted-parent custody and delivery authority, never derived from
   * incoming native bytes. The caller supplies an already authenticated channel. */
  readonly authorize: () => Promise<void>;
  /** Only an exclusive enclosing dispatcher may retain a bounded next control
   * frame after this result. Standalone transfers continue to reject all tail
   * bytes. The dispatcher must validate the next phase before acting on them. */
  readonly allowDispatcherContinuation?: boolean;
  /** Exact next-frame allowance from the enclosing dispatcher, capped at the
   * largest supported file-selection manifest. Standalone use remains zero. */
  readonly dispatcherContinuationMaxBytes?: number;
}
export interface WindowsRuntimeRetentionOwner extends WindowsRuntimeRetentionOptions {
  readonly retain: (resultHex: string, signal: AbortSignal) => Promise<RemoteWorkerRuntimeResultReceipt>;
}
export interface WindowsRuntimeRetentionState {
  readonly resultValidated: boolean;
  readonly validationReceiptSent: boolean;
  readonly retentionAttempted: boolean;
  readonly retentionConfirmed: boolean;
  readonly retentionReceiptAttempted: boolean;
  readonly retentionReceiptSent: boolean;
}
const refused = () => new Error("Native runtime retention was interrupted or did not match protected authority; resolve the exact result before retrying delivery.");

/** Parent side of the existing GCRTS001/GCRTC001 transfer. This exclusive,
 * one-shot adapter never opens a pipe or reruns a workload. Its owner retains
 * and closes the borrowed authenticated channel after success or failure. */
export class WindowsRuntimeResultRetentionParent {
  private readonly expected: RemoteWorkerRuntimeResultExpectation;
  private readonly history: RemoteWorkerCellProvisioningExchange;
  private readonly owner: WindowsRuntimeRetentionOwner;
  private readonly stop = new AbortController();
  private attempted = false;
  private failure: Error | undefined;
  private deadline = 0;
  private terminal = false;
  private continuationMax = 0;
  private progress = { resultValidated: false, validationReceiptSent: false, retentionAttempted: false,
    retentionConfirmed: false, retentionReceiptAttempted: false, retentionReceiptSent: false };
  public constructor(private readonly channel: Duplex, expected: RemoteWorkerRuntimeResultExpectation,
    history: RemoteWorkerCellProvisioningExchange, owner: WindowsRuntimeRetentionOwner) {
    this.expected = normalizeRemoteWorkerRuntimeResultExpectation(expected);
    this.history = normalizeRemoteWorkerCellProvisioningExchange(history);
    this.owner = Object.freeze({ ...owner });
  }
  public get state(): WindowsRuntimeRetentionState { return Object.freeze({ ...this.progress }); }

  public async run(): Promise<RemoteWorkerRuntimeResultReceipt> {
    if (this.attempted) throw this.fail(); this.attempted = true;
    if (!Number.isSafeInteger(this.owner.timeoutMs) || this.owner.timeoutMs < 1 || this.owner.timeoutMs > 600000 ||
        typeof this.owner.authorize !== "function" || typeof this.owner.retain !== "function" || !this.owner.signal ||
        this.channel.readableFlowing === true || this.channel.listenerCount("data") || this.channel.listenerCount("readable")) throw this.fail();
    this.continuationMax = this.owner.allowDispatcherContinuation === true ? (this.owner.dispatcherContinuationMaxBytes ?? 120) : 0;
    if ((this.owner.dispatcherContinuationMaxBytes !== undefined && this.owner.allowDispatcherContinuation !== true) ||
        !Number.isSafeInteger(this.continuationMax) || this.continuationMax < 0 || this.continuationMax > 1644) throw this.fail();
    this.deadline = performance.now() + this.owner.timeoutMs;
    const interrupted = () => { this.fail(); };
    const extra = () => { if (this.terminal && this.channel.readableLength > this.continuationMax) this.fail(); };
    this.owner.signal.addEventListener("abort", interrupted, { once: true });
    this.channel.on("error", interrupted); this.channel.on("close", interrupted); this.channel.on("end", interrupted);
    this.channel.on("readable", extra);
    try {
      await this.authorize();
      const header = await this.read(112), byteLength = header.readUInt32LE(104), digest = header.subarray(72, 104).toString("hex");
      if (!header.subarray(0, 8).equals(Buffer.from("GCRTS001")) || header.subarray(8, 40).toString("hex") !== this.expected.nonce ||
          header.subarray(40, 72).toString("hex") !== this.expected.requestSha256 || /^0+$/u.test(digest) || header.readUInt32LE(108) !== 4096 ||
          byteLength < 256 || byteLength > REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES) throw this.fail();
      const bytes = Buffer.alloc(byteLength);
      for (let offset = 0; offset < byteLength;) {
        await this.authorize();
        const chunk = await this.read(16), count = Math.min(4096, byteLength - offset);
        if (!chunk.subarray(0, 8).equals(Buffer.from("GCRTC001")) || chunk.readUInt32LE(8) !== offset || chunk.readUInt32LE(12) !== count) throw this.fail();
        (await this.read(count)).copy(bytes, offset); offset += count;
      }
      this.terminal = true; this.check();
      const resultHex = bytes.toString("hex"), decoded = readRemoteWorkerRuntimeResult(resultHex, this.expected, this.history);
      if (decoded.resultSha256 !== digest) throw this.fail(); this.progress.resultValidated = true;
      await this.authorize();
      const acknowledgment = Buffer.from(header); acknowledgment.write("GCRTA002", "ascii");
      await this.write(acknowledgment); await this.authorize(); this.progress.validationReceiptSent = true;
      this.progress.retentionAttempted = true;
      const saved = await this.within(() => this.owner.retain(resultHex, this.stop.signal));
      // Read only data descriptors: a returned accessor cannot create authority.
      const descriptors: Record<string, PropertyDescriptor> = saved && typeof saved === "object" ? Object.getOwnPropertyDescriptors(saved) : {};
      const keys = ["resultSha256", "byteLength", "leaseRevision", "recordedAt"] as const;
      if (!saved || ![Object.prototype, null].includes(Object.getPrototypeOf(saved) as object | null) || Reflect.ownKeys(saved).length !== keys.length ||
          keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw this.fail();
      const record = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value])) as unknown as RemoteWorkerRuntimeResultReceipt;
      if (record.resultSha256 !== digest || record.byteLength !== byteLength || !Number.isSafeInteger(record.leaseRevision) || record.leaseRevision < 1 ||
          record.leaseRevision > this.history.leaseRevision || typeof record.recordedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.recordedAt) || !Number.isFinite(Date.parse(record.recordedAt)) ||
          new Date(record.recordedAt).toISOString() !== record.recordedAt) throw this.fail();
      await this.authorize(); this.progress.retentionConfirmed = true;
      acknowledgment.write("GCRTA003", "ascii"); this.progress.retentionReceiptAttempted = true;
      await this.write(acknowledgment); await this.authorize(); this.progress.retentionReceiptSent = true;
      return Object.freeze(record);
    } catch { throw this.fail(); }
    finally {
      this.owner.signal.removeEventListener("abort", interrupted); this.channel.off("error", interrupted);
      this.channel.off("close", interrupted); this.channel.off("end", interrupted); this.channel.off("readable", extra);
    }
  }
  private fail(): Error {
    this.failure ??= refused(); if (!this.stop.signal.aborted) this.stop.abort(this.failure); return this.failure;
  }
  private check(): void {
    if (this.failure || this.owner.signal.aborted || this.channel.destroyed || this.channel.readableEnded || this.channel.writableEnded ||
        performance.now() >= this.deadline || this.channel.readableLength > REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES + 4096 ||
        (this.terminal && this.channel.readableLength > this.continuationMax)) throw this.fail();
  }
  private async authorize(): Promise<void> { await this.within(() => this.owner.authorize()); }
  private async within<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.check(); return operation(); }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(this.failure ?? refused()); this.stop.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(this.fail()), Math.max(1, Math.ceil(this.deadline - performance.now())));
      })]);
      this.check(); return value;
    } finally { if (timer) clearTimeout(timer); if (abort) this.stop.signal.removeEventListener("abort", abort); }
  }
  private async read(count: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    for (;;) {
      this.check(); const wanted = Math.min(count - received, this.channel.readableLength);
      if (wanted) {
        const bytes: unknown = this.channel.read(wanted);
        if (bytes !== null) {
          if (!Buffer.isBuffer(bytes) || bytes.length !== wanted) throw this.fail();
          parts.push(Buffer.from(bytes)); received += bytes.length; this.check();
          if (received === count) return Buffer.concat(parts, count); continue;
        }
      }
      let ready: (() => void) | undefined;
      try { await this.within(() => new Promise<void>(resolve => {
        ready = resolve; this.channel.once("readable", ready);
        if (this.channel.readableLength) resolve();
      })); }
      finally { if (ready) this.channel.off("readable", ready); }
    }
  }
  private async write(bytes: Buffer): Promise<void> {
    const frozen = Buffer.from(bytes);
    await this.within(() => new Promise<void>((resolve, reject) => this.channel.write(frozen, error => error ? reject(error) : resolve())));
  }
}

/** Production composition: only the protected Gateway upload can supply the
 * saved receipt. Credentials stay in RouteContext and never enter native IPC. */
export function createWindowsRuntimeResultGatewayParent(channel: Duplex, context: RouteContext, lease: LeaseBinding,
  expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange, options: WindowsRuntimeRetentionOptions): WindowsRuntimeResultRetentionParent {
  const binding = Object.freeze({ ...lease }), request = normalizeRemoteWorkerRuntimeResultExpectation(expected);
  const retained = normalizeRemoteWorkerCellProvisioningExchange(history), route = Object.freeze({ ...context });
  if (binding.registryWorkspaceId !== retained.registryWorkspaceId || binding.assignmentId !== retained.assignmentId ||
      binding.assignmentGeneration !== retained.assignmentGeneration || binding.leaseRevision !== retained.leaseRevision) throw refused();
  return new WindowsRuntimeResultRetentionParent(channel, request, retained, { ...options, retain: async (hex, signal) => {
    const result = await uploadWorkerRuntimeResult(route, binding, hex, request, retained, signal);
    if (!result.record) throw refused(); return result.record;
  } });
}
