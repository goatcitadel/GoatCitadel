import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerRuntimeResultExpectation,
  type RemoteWorkerCellProvisioningExchange, type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultReceipt,
} from "@goatcitadel/contracts";
import { bindWindowsRuntimeDispatch } from "./worker-windows-runtime-dispatch.js";
import { WindowsRuntimeParentSession, type WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";
import type { WindowsRuntimeReceivedFile } from "./worker-windows-runtime-files.js";

const refused = () => new Error("The native runtime helper connection failed; reconcile retained execution before retrying.");
const nonzero = (bytes: Buffer) => bytes.some(byte => byte !== 0);

/** Private stdin bootstrap. Its secret must never enter arguments, environment,
 * diagnostics or durable evidence. The binding was admitted independently. */
export function encodeWindowsRuntimeHelperBootstrap(request: Uint8Array, expected: RemoteWorkerRuntimeResultExpectation,
  pipeNonce: Uint8Array, secret: Uint8Array): Buffer {
  const binding = normalizeRemoteWorkerRuntimeResultExpectation(expected);
  const bytes = bindWindowsRuntimeDispatch(request, { nonce: binding.nonce, requestSha256: binding.requestSha256 });
  const locator = Buffer.from(pipeNonce), key = Buffer.from(secret), header = Buffer.alloc(176);
  try {
    if (locator.length !== 32 || key.length !== 32 || !nonzero(locator) || !nonzero(key) || locator.equals(key) ||
        [binding.nonce, binding.requestSha256, binding.checkpointSha256].some(value => key.toString("hex") === value) ||
        bytes.subarray(96, 128).toString("hex") !== binding.checkpointSha256) throw refused();
    header.write("GCRHP001"); locator.copy(header, 8); key.copy(header, 40);
    Buffer.from(binding.nonce, "hex").copy(header, 72); Buffer.from(binding.requestSha256, "hex").copy(header, 104);
    Buffer.from(binding.checkpointSha256, "hex").copy(header, 136); header.writeUInt32LE(bytes.length, 168);
    return Buffer.concat([header, bytes]);
  } finally { key.fill(0); header.fill(0); }
}

/** Owns only a private local endpoint. The installed helper is launched and
 * pinned by the provisioning owner, which sends takeBootstrap() through its
 * inherited stdin. Role-bound, one-use hellos authenticate both pipes for this launch;
 * every runtime/input/delivery grant is still checked by the parent session.
 * Keep this endpoint open until that exact child exits, even after completion. */
export class WindowsRuntimeHelperParent {
  public readonly completion: Promise<RemoteWorkerRuntimeResultReceipt>;
  private readonly stop = new AbortController();
  private readonly signal: AbortSignal;
  private readonly server: Server;
  private readonly controlServer: Server;
  private readonly hello: Buffer;
  private readonly controlHello: Buffer;
  private bootstrap: Buffer;
  private socket: Socket | undefined;
  private controlSocket: Socket | undefined;
  private runtimeAuthenticated = false;
  private controlAuthenticated = false;
  private session: WindowsRuntimeParentSession | undefined;
  private taken = false;
  private closed = false;
  private resolve!: (value: RemoteWorkerRuntimeResultReceipt) => void;
  private reject!: (reason: Error) => void;
  private readonly interrupted: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private constructor(private readonly expected: RemoteWorkerRuntimeResultExpectation,
    private readonly history: RemoteWorkerCellProvisioningExchange, request: Uint8Array,
    private readonly owner: WindowsRuntimeParentSessionOwner, private readonly pipeNonce: Buffer, secret: Buffer) {
    this.bootstrap = encodeWindowsRuntimeHelperBootstrap(request, expected, pipeNonce, secret);
    this.hello = Buffer.alloc(136); this.hello.write("GCRPA001"); secret.copy(this.hello, 8);
    Buffer.from(expected.nonce, "hex").copy(this.hello, 40); Buffer.from(expected.requestSha256, "hex").copy(this.hello, 72);
    Buffer.from(expected.checkpointSha256, "hex").copy(this.hello, 104);
    this.controlHello = Buffer.from(this.hello); this.controlHello.write("GCRPC001");
    this.signal = AbortSignal.any([owner.signal, this.stop.signal]);
    this.completion = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Setup can fail before the caller receives this object.
    void this.completion.catch(() => undefined);
    this.interrupted = () => { this.fail(); };
    this.signal.addEventListener("abort", this.interrupted, { once: true });
    this.timer = setTimeout(this.interrupted, owner.timeoutMs);
    this.server = createServer(socket => {
      if (this.socket || this.closed || this.signal.aborted || !this.taken) { socket.destroy(); this.fail(); return; }
      this.socket = socket; socket.on("error", this.interrupted);
      const ended = () => { if (!this.session?.state.finished) this.fail(); }; socket.on("end", ended); socket.on("close", ended);
      void this.accept(socket, false).then(() => this.startSession(), () => this.fail());
    });
    this.server.on("error", this.interrupted);
    this.controlServer = createServer(socket => {
      if (this.controlSocket || this.closed || this.signal.aborted || !this.taken) { socket.destroy(); this.fail(); return; }
      this.controlSocket = socket; socket.on("error", this.interrupted);
      const ended = () => { if (!this.session?.state.finished) this.fail(); }; socket.on("end", ended); socket.on("close", ended);
      void this.accept(socket, true).then(() => this.startSession(), () => this.fail());
    });
    this.controlServer.on("error", this.interrupted);
  }
  public static async open(request: Uint8Array, expected: RemoteWorkerRuntimeResultExpectation,
    history: RemoteWorkerCellProvisioningExchange, owner: WindowsRuntimeParentSessionOwner): Promise<WindowsRuntimeHelperParent> {
    const binding = normalizeRemoteWorkerRuntimeResultExpectation(expected), retained = normalizeRemoteWorkerCellProvisioningExchange(history);
    if (process.platform !== "win32" || !Number.isSafeInteger(owner.timeoutMs) || owner.timeoutMs < 100 || owner.timeoutMs > 86400000 ||
        !owner.signal || retained.mountedWorkspaceRecords?.length !== 2 ||
        retained.mountedWorkspaceRecords[1]!.slice(-64) !== binding.checkpointSha256 ||
        [owner.authorizePeer, owner.authorizeRuntime, owner.authorizeDelivery, owner.authorizeRetention, owner.retain,
          owner.readInput, owner.authorizeInput, owner.consumeOutput].some(callback => typeof callback !== "function")) throw refused();
    owner.signal.throwIfAborted();
    const secret = randomBytes(32), locator = randomBytes(32);
    let parent: WindowsRuntimeHelperParent;
    try { parent = new WindowsRuntimeHelperParent(binding, retained, request, Object.freeze({ ...owner }), locator, secret); }
    finally { secret.fill(0); }
    try {
      for (const [server, name] of [[parent.server, parent.pipeName], [parent.controlServer, parent.controlPipeName]] as const) {
        await parent.within(() => new Promise<void>((resolve, reject) => {
          const error = () => reject(refused()); server.once("error", error);
          server.listen(name, () => { server.off("error", error); resolve(); });
        }));
      }
      return parent;
    } catch { await parent.close(); throw refused(); }
  }
  public get pipeName(): string { return `\\\\.\\pipe\\LOCAL\\GoatCitadelRuntimeParent.v1.${this.pipeNonce.toString("hex")}`; }
  public get controlPipeName(): string { return `${this.pipeName}.control`; }
  public get state() {
    const state = this.session?.state ?? { phase: "connecting", retentionAttempted: false, retentionConfirmed: false, finished: false, cleanupVerified: false };
    const finished = state.finished && !this.signal.aborted && !this.closed;
    return Object.freeze({ ...state, finished, cleanupVerified: finished && state.cleanupVerified });
  }
  public takeBootstrap(): Buffer {
    if (this.taken || this.closed || this.signal.aborted) throw refused();
    this.taken = true;
    const bytes = Buffer.from(this.bootstrap); this.bootstrap.fill(0); this.bootstrap = Buffer.alloc(0); return bytes;
  }
  /** Caller must first validate the exact helper's clean process exit and its
   * outer receipt. Session completion alone is not installed-process proof. */
  public takeFiles(): readonly WindowsRuntimeReceivedFile[] {
    if (!this.state.finished || !this.session) throw this.fail();
    return this.session.takeFiles();
  }
  private fail(): Error {
    const error = refused(); this.reject(error);
    this.session?.discardFiles();
    this.hello.fill(0); this.controlHello.fill(0); this.bootstrap.fill(0); this.socket?.destroy(); this.controlSocket?.destroy();
    if (!this.stop.signal.aborted) this.stop.abort(error);
    return error;
  }
  private async within<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => { cancel = () => reject(refused()); });
    this.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (this.signal.aborted) cancel();
      return await Promise.race([Promise.resolve().then(() => { this.signal.throwIfAborted(); return work(); }), aborted]);
    } finally { this.signal.removeEventListener("abort", cancel); }
  }
  private async accept(socket: Socket, control: boolean): Promise<void> {
    const timer = setTimeout(() => this.fail(), 5000);
    let received = 0;
    const bytes = Buffer.alloc(136);
    const ended = () => this.fail(); socket.on("end", ended); socket.on("close", ended);
    try {
      while (received < bytes.length) {
        if (socket.readableLength > bytes.length - received) throw refused();
        const count = Math.min(socket.readableLength, bytes.length - received);
        if (count) {
          const chunk: unknown = socket.read(count);
          if (!Buffer.isBuffer(chunk) || chunk.length !== count) throw refused();
          chunk.copy(bytes, received); received += count; continue;
        }
        let ready: (() => void) | undefined;
        try { await this.within(() => new Promise<void>(resolve => { ready = resolve; socket.once("readable", ready); if (socket.readableLength) resolve(); })); }
        finally { if (ready) socket.off("readable", ready); }
      }
      const hello = control ? this.controlHello : this.hello;
      if (!timingSafeEqual(bytes, hello) || socket.readableLength) throw refused();
      await this.within(() => this.owner.authorizePeer(this.signal));
      if (socket.readableLength) throw refused();
      bytes[7] = 0x32;
      await this.within(() => new Promise<void>((resolve, reject) => socket.write(bytes, error => error ? reject(refused()) : resolve())));
      hello.fill(0);
      if (control) this.controlAuthenticated = true; else this.runtimeAuthenticated = true;
    } finally {
      clearTimeout(timer); bytes.fill(0); socket.off("end", ended); socket.off("close", ended);
    }
  }
  private startSession(): void {
    if (!this.runtimeAuthenticated || !this.controlAuthenticated || this.session || this.signal.aborted || this.closed) return;
    if (!this.socket || !this.controlSocket || this.socket.destroyed || this.controlSocket.destroyed ||
        this.socket.readableEnded || this.controlSocket.readableEnded) { this.fail(); return; }
    try {
      this.session = new WindowsRuntimeParentSession(this.socket, this.expected, this.history, { ...this.owner, signal: this.signal });
      const runtime = this.session.run(), control = this.session.runControl(this.controlSocket);
      void Promise.all([runtime, control]).then(([receipt]) => this.resolve(receipt), () => this.fail());
    } catch { this.fail(); }
  }
  public async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.signal.removeEventListener("abort", this.interrupted); clearTimeout(this.timer);
    this.fail();
    await Promise.all([this.server, this.controlServer].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}
