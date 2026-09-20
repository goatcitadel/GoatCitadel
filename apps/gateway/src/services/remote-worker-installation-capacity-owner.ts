import {
  assertRemoteWorkerInstallCapacityChallenge,
  canonicalJsonString,
  type RemoteWorkerInstallCapacityBinding,
} from "@goatcitadel/contracts";
import {
  snapshotRemoteWorkerCellCapacityAuthority,
  snapshotRuntimeInstallPoolCapture,
  type AsyncStorage,
  type RemoteWorkerCellCapacityAuthority,
  type RuntimeInstallPoolCapture,
} from "@goatcitadel/storage";

type Selection = RemoteWorkerCellCapacityAuthority & { readonly nonce: string; readonly requestSha256: string };
export interface RemoteWorkerInstallationCaptureWindow {
  /** Current authenticated native session and retained global writer exclusion.
   * Must check this exact binding; it must not start a nested pipe exchange. */
  verify(binding: RemoteWorkerInstallCapacityBinding, signal: AbortSignal): Promise<void>;
}
export interface RemoteWorkerInstallationPolicy {
  /** Read-only current deny-wins policy verification, never approval creation,
   * grant consumption, or waiting for a human decision. */
  verify(selection: Selection, signal: AbortSignal): Promise<void>;
}
export interface RemoteWorkerInstallationReservation {
  readonly binding: RemoteWorkerInstallCapacityBinding;
  readonly signal: AbortSignal;
  verify(challenge: Uint8Array): Promise<void>;
  /** After validating the terminal native receipt, recheck live authority before
   * sending finish. Retain ownership while the caller joins the helper. The
   * callback must not perform further installation work or publish readiness. */
  finish<T>(join: () => Promise<T>): Promise<T>;
}

/** In-process lifetime coordinator, not a worker RPC or durable replay token.
 * The trusted installed-session owner supplies a unique registered window and
 * retains native exclusion through its terminal receipt. Canonical storage and
 * policy are rechecked for every challenge; process-local serialization does
 * not replace those fences or the native journal's single-attempt boundary. */
export class RemoteWorkerInstallationCapacityOwner {
  private readonly windows = new WeakMap<RemoteWorkerInstallationCaptureWindow, () => void>();
  private readonly active = new Set<string>();
  constructor(
    private readonly storage: Pick<AsyncStorage, "remoteWorkerRuntimeInstalls">,
    private readonly policy: RemoteWorkerInstallationPolicy,
  ) {}

  async run<T>(
    input: Selection & {
      readonly capture: RuntimeInstallPoolCapture;
      readonly window: RemoteWorkerInstallationCaptureWindow;
      readonly signal: AbortSignal;
      readonly wallLimitMs: number;
    },
    operation: (reservation: RemoteWorkerInstallationReservation) => Promise<T>,
  ): Promise<T> {
    input.signal.throwIfAborted();
    const capture = snapshotRuntimeInstallPoolCapture(input.capture),
      window = input.window,
      callerSignal = input.signal,
      wallLimitMs = input.wallLimitMs;
    const command = Object.freeze({
      ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: input.nonce,
      requestSha256: input.requestSha256,
    });
    if (
      command.nonce !== capture.binding.installationNonce ||
      command.requestSha256 !== capture.binding.requestSha256 ||
      !Number.isSafeInteger(wallLimitMs) ||
      wallLimitMs < 1 ||
      wallLimitMs > 60000 ||
      !window ||
      typeof window.verify !== "function" ||
      typeof this.policy?.verify !== "function"
    )
      throw new Error("Installation reservation lacks bounded current authority.");
    const prior = this.windows.get(window);
    if (prior) {
      prior();
      throw new Error("Installation capture window has already been consumed.");
    }
    const key = canonicalJsonString([command.registryWorkspaceId, command.assignmentId, command.assignmentGeneration]);
    if (this.active.has(key)) throw new Error("Installation already has an active reservation lifetime.");
    const stop = new AbortController(),
      signal = AbortSignal.any([callerSignal, stop.signal, AbortSignal.timeout(wallLimitMs)]);
    const verifyWindow = window.verify.bind(window),
      verifyPolicy = this.policy.verify.bind(this.policy);
    let active = true,
      acceptingChecks = false,
      busy = false,
      ordinal = 0,
      baselineSha256: string | undefined;
    let pending: Promise<void> | undefined;
    let terminal: Promise<unknown> | undefined,
      terminalStarted = false,
      terminalComplete = false;
    const close = () => {
      active = acceptingChecks = false;
      if (!stop.signal.aborted) stop.abort();
    };
    const control = () => {
      signal.throwIfAborted();
      if (!active) throw new Error("Installation reservation lifetime has ended.");
    };
    this.windows.set(window, close);
    this.active.add(key);
    const check = async () => {
      control();
      await verifyWindow(capture.binding, signal);
      control();
      await verifyPolicy(command, signal);
      control();
      const result = await this.storage.remoteWorkerRuntimeInstalls.validatePoolCaptureForAssignment({
        ...command,
        capture,
      });
      control();
      if (
        canonicalJsonString(result.binding) !== canonicalJsonString(capture.binding) ||
        !/^[a-f0-9]{64}$/u.test(result.baselineSha256) ||
        /^0+$/u.test(result.baselineSha256) ||
        (baselineSha256 !== undefined && baselineSha256 !== result.baselineSha256)
      )
        throw new Error("Installation reservation baseline changed.");
      baselineSha256 = result.baselineSha256;
      await verifyPolicy(command, signal);
      control();
      await verifyWindow(capture.binding, signal);
      control();
    };
    const reservation: RemoteWorkerInstallationReservation = Object.freeze({
      binding: capture.binding,
      signal,
      verify: (supplied: Uint8Array): Promise<void> => {
        if (!acceptingChecks) {
          close();
          return Promise.reject(new Error("Installation challenge is outside its active operation."));
        }
        if (busy) {
          close();
          return Promise.reject(new Error("Installation reservation checks must be serialized."));
        }
        let challenge: Uint8Array;
        try {
          control();
          assertRemoteWorkerInstallCapacityChallenge(supplied, capture.binding, ordinal + 1);
          challenge = Uint8Array.from(supplied);
        } catch (error) {
          close();
          return Promise.reject(error);
        }
        busy = true;
        pending = (async () => {
          try {
            await check();
            assertRemoteWorkerInstallCapacityChallenge(challenge, capture.binding, ordinal + 1);
            ++ordinal;
          } catch (error) {
            close();
            throw error;
          } finally {
            busy = false;
          }
        })();
        return pending;
      },
      finish: <R>(join: () => Promise<R>): Promise<R> => {
        if (!acceptingChecks || busy || ordinal === 0 || terminalStarted || typeof join !== "function") {
          close();
          return Promise.reject(new Error("Installation finish requires completed serialized native checks."));
        }
        acceptingChecks = false;
        terminalStarted = true;
        terminal = (async () => {
          try {
            await check();
            const result = await join();
            control();
            terminalComplete = true;
            return result;
          } catch (error) {
            close();
            throw error;
          }
        })();
        return terminal as Promise<R>;
      },
    });
    try {
      await check();
      acceptingChecks = true;
      const result = await operation(reservation);
      acceptingChecks = false;
      control();
      if (busy || ordinal === 0 || (terminalStarted && !terminalComplete))
        throw new Error("Installation ended without completed serialized native checks.");
      // A successful explicit finish already checked live authority before the
      // final acknowledgement. Its joined helper no longer owns native exclusion.
      if (!terminalComplete) await check();
      return result;
    } finally {
      close();
      // A callback must not leave a verification running after scope release.
      await pending?.catch(() => {
        /* Join cleanup; preserve the owning operation's failure. */
      });
      await terminal?.catch(() => {
        /* Join cleanup; preserve the owning operation's failure. */
      });
      this.active.delete(key);
    }
  }
}
