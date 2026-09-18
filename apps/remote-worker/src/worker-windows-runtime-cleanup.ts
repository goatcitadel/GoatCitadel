import type { Duplex } from "node:stream";
import { encodeRemoteWorkerRuntimeCleanup, type RemoteWorkerRuntimeCleanupExchange } from "@goatcitadel/contracts";

export interface WindowsRuntimeCleanupOwner {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Optional enclosing deadline on this process's performance.now() clock. */
  readonly deadline?: number;
  /** Verify the retained peer and current permission for this exact set.
   * This callback must not renew a lease while an enclosing writer hold is active. */
  readonly authorize: (signal: AbortSignal) => Promise<void>;
}
const refused = () => new Error("Native cleanup transfer was interrupted or did not match protected authority.");
/** One-shot sender on an exclusively owned, already authenticated channel.
 * The owner independently supplies the binding to the native receiver and joins
 * and closes the channel on failure. A receipt proves delivery, not cleanup. */
export class WindowsRuntimeCleanupSender {
  public readonly binding: Readonly<{ challenge: string; setSha256: string }>;
  private readonly bytes: Buffer;
  private readonly owner: WindowsRuntimeCleanupOwner;
  private attempted = false;
  public constructor(private readonly channel: Duplex, exchange: RemoteWorkerRuntimeCleanupExchange, owner: WindowsRuntimeCleanupOwner) {
    const encoded = encodeRemoteWorkerRuntimeCleanup(exchange);
    this.binding = Object.freeze({ challenge: encoded.challenge, setSha256: encoded.setSha256 });
    this.bytes = Buffer.from(encoded.bytesHex, "hex"); this.owner = Object.freeze({ ...owner });
    if (!Number.isSafeInteger(owner.timeoutMs) || owner.timeoutMs < 1 || owner.timeoutMs > 60000 || typeof owner.authorize !== "function" ||
      (owner.deadline !== undefined && (!Number.isFinite(owner.deadline) || owner.deadline < 0))) throw refused();
  }
  public async send() {
    if (this.attempted) throw refused(); this.attempted = true;
    const stop = new AbortController(), now = performance.now();
    const deadline = Math.min(now + this.owner.timeoutMs, this.owner.deadline ?? Infinity);
    const timer = setTimeout(() => stop.abort(refused()), Math.max(1, Math.ceil(deadline - now)));
    const signal = AbortSignal.any([this.owner.signal, stop.signal]);
    const fail = () => stop.abort(refused());
    const overflow = () => { if (this.channel.readableLength > 80) fail(); };
    const check = () => {
      signal.throwIfAborted();
      if (this.channel.destroyed || this.channel.readableEnded || this.channel.writableEnded || this.channel.readableObjectMode ||
          this.channel.writableObjectMode || this.channel.readableFlowing === true || this.channel.listenerCount("data") > 0 ||
          this.channel.readableLength > 80 || performance.now() >= deadline) throw refused();
    };
    const within = async <T>(operation: () => Promise<T>): Promise<T> => {
      check(); let abort: (() => void) | undefined;
      try {
        const result = await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), new Promise<never>((_resolve, reject) => {
          abort = () => reject(refused()); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
        })]);
        check(); return result;
      } finally { if (abort) signal.removeEventListener("abort", abort); }
    };
    const authorize = () => within(() => this.owner.authorize(signal));
    const write = (bytes: Buffer) => within(() => new Promise<void>((resolve, reject) => this.channel.write(bytes, error => error ? reject(error) : resolve())));
    const header = (magic: string, size: number) => {
      const frame = Buffer.alloc(size); frame.write(magic, "ascii"); Buffer.from(this.binding.challenge, "hex").copy(frame, 8);
      Buffer.from(this.binding.setSha256, "hex").copy(frame, 40); frame.writeUInt32LE(this.bytes.length, 72); return frame;
    };
    this.channel.on("error", fail); this.channel.on("close", fail); this.channel.on("end", fail); this.channel.on("readable", overflow);
    try {
      await authorize();
      if (this.channel.readableLength) throw refused();
      const start = header("GCCLX001", 96); start.writeUInt32LE(4096, 76); await write(start); await authorize();
      for (let offset = 0; offset < this.bytes.length;) {
        await authorize(); const count = Math.min(4096, this.bytes.length - offset), frame = Buffer.alloc(16);
        frame.write("GCCLD001", "ascii"); frame.writeUInt32LE(offset, 8); frame.writeUInt32LE(count, 12);
        await write(frame); await write(Buffer.from(this.bytes.subarray(offset, offset + count))); await authorize(); offset += count;
      }
      const chunks: Buffer[] = []; let received = 0;
      while (received < 80) {
        check(); const count = Math.min(80 - received, this.channel.readableLength);
        if (count) {
          const bytes: unknown = this.channel.read(count);
          if (!Buffer.isBuffer(bytes) || bytes.length !== count) throw refused();
          chunks.push(Buffer.from(bytes)); received += count;
        } else {
          let ready: (() => void) | undefined;
          try { await within(() => new Promise<void>(resolve => { ready = resolve; this.channel.once("readable", ready); if (this.channel.readableLength) resolve(); })); }
          finally { if (ready) this.channel.off("readable", ready); }
        }
      }
      if (!Buffer.concat(chunks, 80).equals(header("GCCLA001", 80))) throw refused();
      await authorize(); if (this.channel.readableLength) throw refused();
      return Object.freeze({ ...this.binding, byteLength: this.bytes.length });
    } catch { stop.abort(refused()); throw refused(); }
    finally {
      clearTimeout(timer); this.channel.off("error", fail); this.channel.off("close", fail); this.channel.off("end", fail); this.channel.off("readable", overflow);
    }
  }
}
