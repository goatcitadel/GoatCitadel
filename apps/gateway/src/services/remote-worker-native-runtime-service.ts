import {
  parseRemoteWorkerRuntimeConfig,
  type EnabledRemoteWorkerRuntimeConfig,
} from "./remote-worker-runtime-config.js";
import {
  startRemoteWorkerNativeTlsListener,
  type RemoteWorkerNativeTlsListenerHandle,
} from "./remote-worker-native-tls-listener.js";
import {
  SharedHostAdmissionClosedError,
  type SharedHostLifecycleAdmissionPort,
  type SharedHostWorkReservation,
} from "./shared-host-lifecycle-service.js";

export type RemoteWorkerNativeRuntimeState =
  | "uninitialized"
  | "disabled"
  | "starting"
  | "listening_dark"
  | "failed_closed"
  | "closed";

export interface RemoteWorkerNativeRuntimeSnapshot {
  readonly state: RemoteWorkerNativeRuntimeState;
  readonly enabled: boolean;
  readonly address?: string;
}

export interface RemoteWorkerNativeRuntimeService {
  snapshot(): RemoteWorkerNativeRuntimeSnapshot;
  start(): Promise<RemoteWorkerNativeRuntimeSnapshot>;
  reload(): Promise<RemoteWorkerNativeRuntimeSnapshot>;
  close(): Promise<void>;
}

export class RemoteWorkerNativeRuntimeClosedError extends Error {
  readonly code = "REMOTE_WORKER_NATIVE_RUNTIME_CLOSED";

  constructor() {
    super("Remote worker native runtime is closed.");
    this.name = "RemoteWorkerNativeRuntimeClosedError";
  }
}

const LISTENER_START_RESERVATION_ID = "gateway:remote-worker-native-listener-startup";

export function createRemoteWorkerNativeRuntimeService(input: {
  readonly sharedHostLifecycle: SharedHostLifecycleAdmissionPort;
}): RemoteWorkerNativeRuntimeService {
  return new DefaultRemoteWorkerNativeRuntimeService(input.sharedHostLifecycle);
}

class DefaultRemoteWorkerNativeRuntimeService implements RemoteWorkerNativeRuntimeService {
  private state: RemoteWorkerNativeRuntimeState = "uninitialized";
  private handle: RemoteWorkerNativeTlsListenerHandle | undefined;
  private tail: Promise<void> = Promise.resolve();
  private terminalRequested = false;
  private closePromise: Promise<void> | undefined;
  private inFlightStartAbort: AbortController | undefined;

  constructor(private readonly sharedHostLifecycle: SharedHostLifecycleAdmissionPort) {}

  snapshot(): RemoteWorkerNativeRuntimeSnapshot {
    return snapshot(this.state, this.handle);
  }

  start(): Promise<RemoteWorkerNativeRuntimeSnapshot> {
    return this.serialize(async () => {
      this.assertOpen();
      if (this.state === "disabled" || this.state === "listening_dark") return this.snapshot();
      if (this.state !== "uninitialized") {
        throw new Error("Remote worker native runtime has failed closed; use an explicit reload to retry.");
      }
      return await this.activate();
    });
  }

  reload(): Promise<RemoteWorkerNativeRuntimeSnapshot> {
    return this.serialize(async () => {
      this.assertOpen();
      this.state = "starting";
      try {
        await this.closeActiveHandle();
      } catch (error) {
        this.state = "failed_closed";
        throw error;
      }
      this.assertOpen();
      this.state = "uninitialized";
      return await this.activate();
    });
  }

  close(): Promise<void> {
    this.terminalRequested = true;
    this.inFlightStartAbort?.abort(new RemoteWorkerNativeRuntimeClosedError());
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.serialize(async () => {
      try {
        await this.closeActiveHandle();
        this.state = "closed";
      } catch (error) {
        this.state = "failed_closed";
        throw error;
      }
    });
    return this.closePromise;
  }

  private async activate(): Promise<RemoteWorkerNativeRuntimeSnapshot> {
    try {
      // Configuration is intentionally read only from the server process environment.
      // No caller-provided config object can make the production listener bind.
      const config = parseRemoteWorkerRuntimeConfig(process.env);
      if (!config.enabled) {
        this.state = "disabled";
        return this.snapshot();
      }

      this.state = "starting";
      const admission = this.sharedHostLifecycle.tryReserve("worker", LISTENER_START_RESERVATION_ID);
      if (!admission.admitted) {
        throw new SharedHostAdmissionClosedError(admission.state, admission.reason);
      }
      return await this.startAdmitted(config, admission.reservation);
    } catch (error) {
      this.state = this.terminalRequested ? "closed" : "failed_closed";
      throw error;
    }
  }

  private async startAdmitted(
    config: EnabledRemoteWorkerRuntimeConfig,
    reservation: SharedHostWorkReservation,
  ): Promise<RemoteWorkerNativeRuntimeSnapshot> {
    const localAbort = new AbortController();
    this.inFlightStartAbort = localAbort;
    try {
      // The listener owns bounded trust loading and bind cleanup but has no
      // cancellation input. Await it to completion so an aborted late bind can
      // be synchronously closed before this operation releases admission.
      const handle = await startRemoteWorkerNativeTlsListener(config);
      this.handle = handle;
      if (!handle.enabled || reservation.signal.aborted || localAbort.signal.aborted || this.terminalRequested) {
        await this.closeActiveHandle();
        throw abortReason(reservation.signal, localAbort.signal);
      }
      this.state = "listening_dark";
      return this.snapshot();
    } finally {
      if (this.inFlightStartAbort === localAbort) this.inFlightStartAbort = undefined;
      reservation.release();
    }
  }

  private async closeActiveHandle(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined) return;
    await handle.close();
    if (this.handle === handle) this.handle = undefined;
  }

  private assertOpen(): void {
    if (this.terminalRequested || this.state === "closed") throw new RemoteWorkerNativeRuntimeClosedError();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function abortReason(reservationSignal: AbortSignal, localSignal: AbortSignal): Error {
  const reason = localSignal.aborted ? localSignal.reason : reservationSignal.reason;
  return reason instanceof Error ? reason : new Error("Remote worker native listener startup was interrupted.");
}

function snapshot(
  state: RemoteWorkerNativeRuntimeState,
  handle: RemoteWorkerNativeTlsListenerHandle | undefined,
): RemoteWorkerNativeRuntimeSnapshot {
  const value = Object.assign(Object.create(null) as Record<string, unknown>, {
    state,
    enabled: state === "listening_dark",
    ...(state === "listening_dark" && handle?.address !== undefined ? { address: handle.address } : {}),
  });
  return Object.freeze(value) as unknown as RemoteWorkerNativeRuntimeSnapshot;
}
