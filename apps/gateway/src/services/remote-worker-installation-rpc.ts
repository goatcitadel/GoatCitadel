import { createHash, randomBytes } from "node:crypto";
import { canonicalJsonString, captureRemoteWorkerNativePoolCapacityResponse, hashRemoteWorkerInstallCapacityCapture,
  normalizeRemoteWorkerInstallCapacityBinding, normalizeRemoteWorkerInstallationSubmission,
  REMOTE_WORKER_INSTALLATION_BUFFER_BYTES, REMOTE_WORKER_INSTALLATION_PAGE_BYTES,
  type RemoteWorkerInstallationSubmission, type RemoteWorkerInstallationReply, type RemoteWorkerInstallationEvent } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { awaitControllerAuthority } from "./remote-worker-controller-attestation.js";
import type { RemoteWorkerInstallationSessionOwner } from "./remote-worker-installation-session.js";

type Command = RemoteWorkerCellCapacityAuthority & { submission: RemoteWorkerInstallationSubmission; signal: AbortSignal };
type Event = { event: RemoteWorkerInstallationEvent; payloadHex: string };
type Material = Awaited<ReturnType<AsyncStorage["remoteWorkerRuntimeInstalls"]["readControllerCaptureContextForAssignment"]>>;
const refused = () => new Error("Installation session is unavailable or no longer current.");
const hex = (value: unknown) => Buffer.from(canonicalJsonString(value)).toString("hex");
const json = (value: string): Record<string, unknown> => {
  const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex")));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw refused();
  return result as Record<string, unknown>;
};
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
};
function slot<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
interface State {
  readonly sessionId: string;
  readonly authority: RemoteWorkerCellCapacityAuthority;
  readonly stop: AbortController;
  readonly signal: AbortSignal;
  readonly deadline: number;
  sequence: number; busy: boolean;
  phase: "preparing" | "material" | "capture" | "running" | "finished";
  material?: Material; bytes?: Buffer; offset: number; capture: Buffer[]; captureBytes: number;
  nonce: string; requestSha256: string; captureNonce: string;
  event: ReturnType<typeof slot<Event>>;
  command?: ReturnType<typeof slot<RemoteWorkerInstallationSubmission>>;
  proof?: ReturnType<typeof slot<unknown>>;
  running?: Promise<void>;
}

/** A bounded, one-attempt RPC pump over protected route 12. No reconnect,
 * replay or success cache is accepted. Native journal intent remains the final
 * no-recopy boundary. Losing a response leaves an uncertain result for recovery.
 * Every RPC is fenced by the existing mTLS/PoP/assignment owner; live signing,
 * policy and repository checks remain inside the installation session owner. */
export class RemoteWorkerInstallationRpc {
  private readonly states = new Map<string, State>();
  constructor(private readonly storage: Pick<AsyncStorage, "remoteWorkerRuntimeInstalls">,
    private readonly sessions: Pick<RemoteWorkerInstallationSessionOwner, "runSigned">) {}

  async exchange(input: Command): Promise<RemoteWorkerInstallationReply> {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const request = normalizeRemoteWorkerInstallationSubmission(input.submission);
    const key = canonicalJsonString([authority.registryWorkspaceId, authority.assignmentId, authority.assignmentGeneration]);
    let state = this.states.get(key);
    if (request.action === "prepare") {
      if (state || this.states.size >= 4 || request.sequence !== 1) throw refused();
      const payload = json(request.payloadHex);
      if (Object.keys(payload).sort().join() !== "nonce,requestSha256") throw refused();
      const stop = new AbortController();
      state = { sessionId: request.sessionId, authority, stop, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]),
        deadline: performance.now() + 60000, sequence: 0, busy: false, phase: "preparing", offset: 0, capture: [], captureBytes: 0,
        nonce: digest(payload.nonce), requestSha256: digest(payload.requestSha256), captureNonce: randomBytes(32).toString("hex"), event: slot<Event>() };
      this.states.set(key, state);
      const retained = state;
      state.signal.addEventListener("abort", () => { if (this.states.get(key) === retained) this.states.delete(key); }, { once: true });
    }
    if (!state) throw refused();
    const same = canonicalJsonString(authority) === canonicalJsonString(state.authority);
    if (!same || state.sessionId !== request.sessionId) throw refused();
    if (state.busy || request.sequence !== state.sequence + 1) { state.stop.abort(); throw refused(); }
    state.busy = true; state.sequence = request.sequence;
    const signal = AbortSignal.any([input.signal, state.signal]);
    try {
      signal.throwIfAborted();
      const output = await awaitControllerAuthority(() => this.dispatch(state!, request), signal);
      signal.throwIfAborted();
      if (output.event === "complete") { this.states.delete(key); state.stop.abort(); }
      return Object.freeze({ sessionId: request.sessionId, sequence: request.sequence, ...output });
    } catch (error) { state.stop.abort(); this.states.delete(key); throw error; }
    finally { state.busy = false; }
  }

  private async dispatch(state: State, request: RemoteWorkerInstallationSubmission): Promise<Event> {
    if (request.action === "cancel") throw refused();
    if (request.action === "prepare") {
      state.material = await this.storage.remoteWorkerRuntimeInstalls.readControllerCaptureContextForAssignment({
        ...state.authority, nonce: state.nonce, requestSha256: state.requestSha256 });
      state.signal.throwIfAborted();
      const { baseline, referencesJson } = state.material;
      state.bytes = Buffer.from(canonicalJsonString({ history: baseline.history, request: baseline.request,
        capture: { pool: baseline.pool, layout: baseline.layout, referencesJson, captureNonce: state.captureNonce } }));
      if (state.bytes.length > REMOTE_WORKER_INSTALLATION_BUFFER_BYTES) throw refused();
      state.phase = "material";
      return this.page(state);
    }
    if (request.action === "material") {
      if (state.phase !== "material" || request.payloadHex) throw refused(); return this.page(state);
    }
    if (request.action === "capture") {
      const bytes = Buffer.from(request.payloadHex, "hex");
      if (state.phase !== "capture" || !bytes.length || bytes.length > REMOTE_WORKER_INSTALLATION_PAGE_BYTES ||
          state.captureBytes + bytes.length > REMOTE_WORKER_INSTALLATION_BUFFER_BYTES) throw refused();
      state.capture.push(bytes); state.captureBytes += bytes.length;
      return { event: "uploaded", payloadHex: hex({ offset: state.captureBytes }) };
    }
    if (request.action === "start") {
      if (state.phase !== "capture" || !state.material || !state.captureBytes) throw refused();
      const binding = normalizeRemoteWorkerInstallCapacityBinding(json(request.payloadHex) as unknown as Parameters<typeof normalizeRemoteWorkerInstallCapacityBinding>[0]);
      const bytes = Buffer.concat(state.capture); state.capture = []; state.captureBytes = 0;
      if (binding.byteLength !== bytes.length || binding.captureSha256 !== hashRemoteWorkerInstallCapacityCapture(bytes)) throw refused();
      const { baseline, referencesJson } = state.material;
      const responseHex = bytes.toString("hex");
      const delivery = captureRemoteWorkerNativePoolCapacityResponse(responseHex, baseline.pool, baseline.layout,
        state.captureNonce, JSON.parse(referencesJson));
      state.phase = "running";
      const pending = state.event;
      state.running = this.sessions.runSigned({ ...state.authority, nonce: state.nonce, requestSha256: state.requestSha256,
        window: delivery.window, referencesJson, wallLimitMs: Math.max(1, Math.floor(state.deadline - performance.now())), signal: state.signal },
      { signal: state.signal, challenge: async (nonce, ordinal, signal) => {
        if (state.proof) throw refused();
        const proof = state.proof = slot<unknown>();
        this.publish(state, { event: "challenge", payloadHex: hex({ nonce, ordinal }) });
        try { return await awaitControllerAuthority(() => proof.promise, signal); }
        finally { state.proof = undefined; }
      } }, session => session.runCapture(responseHex, binding, async reservation => {
        while (true) {
          const next = state.command = slot<RemoteWorkerInstallationSubmission>();
          this.publish(state, { event: "ready", payloadHex: "" });
          const command = await awaitControllerAuthority(() => next.promise, state.signal); state.command = undefined;
          if (command.action === "verify") await reservation.verify(Buffer.from(command.payloadHex, "hex"));
          else if (command.action === "finish" && command.payloadHex === "") {
            await reservation.finish(async () => {
              const joined = state.command = slot<RemoteWorkerInstallationSubmission>();
              this.publish(state, { event: "finish", payloadHex: "" });
              const result = await awaitControllerAuthority(() => joined.promise, state.signal); state.command = undefined;
              if (result.action !== "joined" || result.payloadHex) throw refused();
            });
            return;
          } else throw refused();
        }
      })).then(() => { state.phase = "finished"; this.publish(state, { event: "complete", payloadHex: "" }); })
        .catch(() => { state.stop.abort(); });
      return pending.promise;
    }
    if (state.phase !== "running") throw refused();
    const pending = state.event;
    if (request.action === "proof") {
      if (!state.proof) throw refused(); state.proof.resolve(json(request.payloadHex));
    } else {
      if (!state.command || state.proof) throw refused(); state.command.resolve(request);
    }
    return pending.promise;
  }
  private page(state: State): Event {
    const bytes = state.bytes!;
    const offset = state.offset, chunk = bytes.subarray(offset, offset + REMOTE_WORKER_INSTALLATION_PAGE_BYTES);
    state.offset += chunk.length;
    const result: Event = { event: "material", payloadHex: hex({ offset, total: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytesHex: chunk.toString("hex") }) };
    if (state.offset === bytes.length) { state.phase = "capture"; state.bytes = undefined; }
    return result;
  }
  private publish(state: State, event: Event): void {
    const pending = state.event; state.event = slot<Event>(); pending.resolve(event);
  }
}
