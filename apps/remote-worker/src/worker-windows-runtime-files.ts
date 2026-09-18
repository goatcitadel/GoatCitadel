import { createHash } from "node:crypto";
import { normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerRuntimeResultExpectation,
  normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerNativeFileSelections, readRemoteWorkerNativeFileContent,
  type RemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileExportSelection,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";

export interface WindowsRuntimeFileBatchOwner {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Exclusive enclosing dispatcher supplies exact bounded reads/writes on its
   * already authenticated data pipe. These operations never open an endpoint. */
  readonly read: (count: number, signal: AbortSignal) => Promise<Buffer>;
  readonly write: (bytes: Buffer, signal: AbortSignal) => Promise<void>;
  readonly authorizePeer: (signal: AbortSignal) => Promise<void>;
  readonly authorizeFile: (selection: RemoteWorkerNativeFileExportSelection, signal: AbortSignal) => Promise<void>;
}
export interface WindowsRuntimeReceivedFile {
  readonly selection: RemoteWorkerNativeFileExportSelection;
  /** Private native record. The receiving owner must wipe this buffer after
   * settlement or failure. Receipt alone does not authorize publication. */
  readonly record: Buffer;
}
const refused = () => new Error("Native file batch differs from retained evidence or current delivery authority.");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

/** One complete bounded file batch, following independently confirmed result
 * retention. No artifact, upload or durable grant is created here. */
export class WindowsRuntimeFileBatchReceiver {
  private readonly plan: RemoteWorkerNativeFileStaging;
  private readonly expected: RemoteWorkerRuntimeResultExpectation;
  private readonly history: RemoteWorkerCellProvisioningExchange;
  private readonly owner: WindowsRuntimeFileBatchOwner;
  private readonly stop = new AbortController();
  private attempted = false;
  private completed = false;
  private failure: Error | undefined;
  private deadline = 0;
  public constructor(plan: RemoteWorkerNativeFileStaging, expected: RemoteWorkerRuntimeResultExpectation,
    private readonly retainedResultHex: string, history: RemoteWorkerCellProvisioningExchange, owner: WindowsRuntimeFileBatchOwner) {
    this.plan = normalizeRemoteWorkerNativeFileStaging(plan);
    this.expected = normalizeRemoteWorkerRuntimeResultExpectation(expected);
    this.history = normalizeRemoteWorkerCellProvisioningExchange(history);
    this.owner = Object.freeze({ ...owner });
  }
  public get state() { return Object.freeze({ completed: this.completed && !this.failure }); }
  public async run(): Promise<readonly WindowsRuntimeReceivedFile[]> {
    if (this.attempted) throw this.fail(); this.attempted = true;
    if (!Number.isSafeInteger(this.owner.timeoutMs) || this.owner.timeoutMs < 1 || this.owner.timeoutMs > 600000 ||
        !this.owner.signal || [this.owner.read, this.owner.write, this.owner.authorizePeer, this.owner.authorizeFile].some(fn => typeof fn !== "function")) throw this.fail();
    this.deadline = performance.now() + this.owner.timeoutMs;
    const interrupted = () => { this.fail(); };
    this.owner.signal.addEventListener("abort", interrupted, { once: true });
    const files: WindowsRuntimeReceivedFile[] = [];
    let current: Buffer | undefined;
    try {
      await this.authorize();
      const manifest = await this.read(108 + 24 * this.plan.paths.length);
      const selections = readRemoteWorkerNativeFileSelections(manifest.toString("hex"), this.plan,
        this.expected, this.retainedResultHex, this.history);
      for (const selection of selections) await this.authorize(selection);
      const digest = hash(manifest), receipt = Buffer.alloc(40); receipt.write("GCFSA001"); digest.copy(receipt, 8);
      await this.write(receipt);
      for (const selection of selections) {
        await this.authorize(selection);
        const header = await this.read(112), length = 200 + selection.logicalFileBytes;
        if (header.subarray(0, 8).toString("ascii") !== "GCFHS001" || header.subarray(8, 40).toString("hex") !== selection.nonce ||
            header.subarray(40, 72).toString("hex") !== selection.requestSha256 || header.readUInt32LE(104) !== length ||
            header.readUInt32LE(108) !== 4096 || header.subarray(72, 104).every(byte => byte === 0)) throw this.fail();
        current = Buffer.alloc(length);
        for (let offset = 0; offset < length;) {
          await this.authorize(selection);
          const chunk = await this.read(16), count = Math.min(4096, length - offset);
          if (chunk.subarray(0, 8).toString("ascii") !== "GCFHC001" || chunk.readUInt32LE(8) !== offset || chunk.readUInt32LE(12) !== count) throw this.fail();
          const fragment = await this.read(count);
          try { fragment.copy(current, offset); } finally { fragment.fill(0); }
          offset += count;
          await this.authorize(selection);
        }
        if (!hash(current).equals(header.subarray(72, 104))) throw this.fail();
        readRemoteWorkerNativeFileContent(current.toString("hex"), selection);
        await this.authorize(selection);
        const acknowledgment = Buffer.from(header); acknowledgment.write("GCFHA001");
        await this.write(acknowledgment); await this.authorize(selection);
        files.push(Object.freeze({ selection, record: current })); current = undefined;
      }
      await this.authorize();
      const complete = Buffer.alloc(40); complete.write("GCFSD001"); digest.copy(complete, 8);
      await this.write(complete); await this.authorize();
      this.completed = true; return Object.freeze(files);
    } catch {
      current?.fill(0); for (const file of files) file.record.fill(0);
      throw this.fail();
    } finally { this.owner.signal.removeEventListener("abort", interrupted); }
  }
  private async authorize(selection?: RemoteWorkerNativeFileExportSelection): Promise<void> {
    await this.within(() => this.owner.authorizePeer(this.stop.signal));
    if (selection) {
      await this.within(() => this.owner.authorizeFile(selection, this.stop.signal));
      await this.within(() => this.owner.authorizePeer(this.stop.signal));
    }
  }
  private async read(count: number): Promise<Buffer> {
    const bytes = await this.within(() => this.owner.read(count, this.stop.signal));
    if (!Buffer.isBuffer(bytes) || bytes.length !== count) throw this.fail();
    return Buffer.from(bytes);
  }
  private async write(bytes: Buffer): Promise<void> { await this.within(() => this.owner.write(Buffer.from(bytes), this.stop.signal)); }
  private check(): void {
    if (this.failure || this.owner.signal.aborted || this.stop.signal.aborted || performance.now() >= this.deadline) throw this.fail();
  }
  private fail(): Error { this.failure ??= refused(); this.stop.abort(); return this.failure; }
  private async within<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.check(); return operation(); }), new Promise<never>((_resolve, reject) => {
        aborted = () => { reject(this.fail()); }; this.stop.signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(aborted, Math.max(1, this.deadline - performance.now()));
      })]);
      this.check(); return value;
    } finally { clearTimeout(timer); if (aborted) this.stop.signal.removeEventListener("abort", aborted); }
  }
}
