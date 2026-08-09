import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_RUNTIME_ENV } from "./remote-worker-runtime-config.js";
import type {
  RemoteWorkerNativeRequestHandler,
  RemoteWorkerNativeTlsListenerHandle,
} from "./remote-worker-native-tls-listener.js";
import type { SharedHostLifecycleAdmissionPort, SharedHostWorkReservation } from "./shared-host-lifecycle-service.js";

const listenerMocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock("./remote-worker-native-tls-listener.js", () => ({
  startRemoteWorkerNativeTlsListener: listenerMocks.start,
}));

import {
  createRemoteWorkerNativeRuntimeService,
  RemoteWorkerNativeRuntimeClosedError,
} from "./remote-worker-native-runtime-service.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const remoteWorkerEnvNames = Object.values(REMOTE_WORKER_RUNTIME_ENV);
const originalEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  listenerMocks.start.mockReset();
  for (const name of remoteWorkerEnvNames) {
    originalEnvironment.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of remoteWorkerEnvNames) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
  vi.restoreAllMocks();
});

describe("remote worker native runtime service", () => {
  it("accepts exactly one static or dynamic handler owner", () => {
    expect(() =>
      createRemoteWorkerNativeRuntimeService({
        sharedHostLifecycle: lifecycleMock().port,
        handler: vi.fn(),
        createHandler: vi.fn(),
      }),
    ).toThrow("one handler owner");
  });

  it("defaults disabled without reserving work, loading trust, or binding", async () => {
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });

    expect(service.snapshot()).toEqual({ state: "uninitialized", enabled: false });
    expect(Object.getPrototypeOf(service.snapshot())).toBeNull();
    await expect(service.start()).resolves.toEqual({ state: "disabled", enabled: false });

    expect(lifecycle.tryReserve).not.toHaveBeenCalled();
    expect(listenerMocks.start).not.toHaveBeenCalled();
    await Promise.all([service.close(), service.close()]);
    expect(service.snapshot()).toEqual({ state: "closed", enabled: false });
  });

  it("reads enabled configuration from server environment and releases the exact reservation", async () => {
    enableEnvironment();
    const handle = listenerHandle("127.0.0.1:9443");
    listenerMocks.start.mockResolvedValue(handle);
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });

    await expect(service.start()).resolves.toEqual({
      state: "listening_dark",
      enabled: true,
      address: "127.0.0.1:9443",
    });
    await expect(service.start()).resolves.toEqual(service.snapshot());

    expect(lifecycle.tryReserve).toHaveBeenCalledTimes(1);
    expect(lifecycle.tryReserve).toHaveBeenCalledWith("worker", "gateway:remote-worker-native-listener-startup");
    expect(lifecycle.release).toHaveBeenCalledTimes(1);
    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
    expect(listenerMocks.start.mock.calls[0]?.[0]).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 9443,
    });
    expect(listenerMocks.start.mock.calls[0]?.[1]).toBeUndefined();

    await service.close();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("resolves the production handler from the exact enabled config and stays dark when it is unavailable", async () => {
    enableEnvironment();
    const handle = listenerHandle("127.0.0.1:9443");
    listenerMocks.start.mockResolvedValue(handle);
    const lifecycle = lifecycleMock();
    const createHandler = vi.fn(async () => undefined);
    const service = createRemoteWorkerNativeRuntimeService({
      sharedHostLifecycle: lifecycle.port,
      createHandler,
    });

    await expect(service.start()).resolves.toEqual({
      state: "listening_dark",
      enabled: true,
      address: "127.0.0.1:9443",
    });
    expect(createHandler).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, port: 9443 }));
    expect(listenerMocks.start.mock.calls[0]?.[1]).toBeUndefined();
    await service.close();
  });

  it("fails closed before binding when production handler preflight is unavailable", async () => {
    enableEnvironment();
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({
      sharedHostLifecycle: lifecycle.port,
      createHandler: vi.fn(async () => {
        throw new Error("trusted evidence unavailable");
      }),
    });

    await expect(service.start()).rejects.toThrow("trusted evidence unavailable");
    expect(service.snapshot()).toEqual({ state: "failed_closed", enabled: false });
    expect(listenerMocks.start).not.toHaveBeenCalled();
    expect(lifecycle.release).toHaveBeenCalledTimes(1);
  });

  it("reports a handler-backed listener as live across start, reload, and close", async () => {
    enableEnvironment();
    const firstHandle = listenerHandle("127.0.0.1:9443");
    const replacementHandle = listenerHandle("127.0.0.1:9555");
    listenerMocks.start.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(replacementHandle);
    const handler = vi.fn(async () => ({ statusCode: 200, body: "{}" })) as RemoteWorkerNativeRequestHandler;
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port, handler });

    await expect(service.start()).resolves.toEqual({
      state: "listening_live",
      enabled: true,
      address: "127.0.0.1:9443",
    });
    await expect(service.start()).resolves.toEqual(service.snapshot());
    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
    expect(listenerMocks.start.mock.calls[0]?.[1]).toBe(handler);

    await expect(service.reload()).resolves.toEqual({
      state: "listening_live",
      enabled: true,
      address: "127.0.0.1:9555",
    });
    expect(firstHandle.close).toHaveBeenCalledTimes(1);
    expect(listenerMocks.start.mock.calls[1]?.[1]).toBe(handler);

    await service.close();
    expect(replacementHandle.close).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ state: "closed", enabled: false });
  });

  it("fails closed and releases admission when listener startup rejects or host drain aborts", async () => {
    enableEnvironment();
    const startError = new Error("listener failed");
    listenerMocks.start.mockRejectedValueOnce(startError);
    const failedLifecycle = lifecycleMock();
    const failed = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: failedLifecycle.port });

    await expect(failed.start()).rejects.toBe(startError);
    expect(failed.snapshot()).toEqual({ state: "failed_closed", enabled: false });
    expect(failedLifecycle.release).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const lateHandle = listenerHandle("127.0.0.1:9555");
    let resolveListener: ((handle: RemoteWorkerNativeTlsListenerHandle) => void) | undefined;
    listenerMocks.start.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkerNativeTlsListenerHandle>((resolveStart) => {
          resolveListener = resolveStart;
        }),
    );
    const abortedLifecycle = lifecycleMock(controller.signal);
    const aborted = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: abortedLifecycle.port });
    const starting = aborted.start();
    await vi.waitFor(() => expect(aborted.snapshot().state).toBe("starting"));
    controller.abort(new Error("host draining"));
    resolveListener?.(lateHandle);
    await expect(starting).rejects.toThrow("host draining");
    expect(aborted.snapshot()).toEqual({ state: "failed_closed", enabled: false });
    expect(abortedLifecycle.release).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(lateHandle.close).toHaveBeenCalledTimes(1));
  });

  it("serializes concurrent starts and aborts an in-flight start on irreversible close", async () => {
    enableEnvironment();
    const handle = listenerHandle("127.0.0.1:9666");
    let resolveListener: ((value: RemoteWorkerNativeTlsListenerHandle) => void) | undefined;
    listenerMocks.start.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkerNativeTlsListenerHandle>((resolveStart) => {
          resolveListener = resolveStart;
        }),
    );
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });
    const first = service.start();
    const second = service.start();
    await vi.waitFor(() => expect(service.snapshot().state).toBe("starting"));

    const closed = service.close();
    resolveListener?.(handle);
    await expect(first).rejects.toBeInstanceOf(RemoteWorkerNativeRuntimeClosedError);
    await expect(second).rejects.toBeInstanceOf(RemoteWorkerNativeRuntimeClosedError);
    await closed;

    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.release).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ state: "closed", enabled: false });
    await expect(service.reload()).rejects.toBeInstanceOf(RemoteWorkerNativeRuntimeClosedError);
  });

  it("closes the old listener before reload and never resurrects it when replacement fails", async () => {
    enableEnvironment();
    const order: string[] = [];
    const oldHandle = listenerHandle("127.0.0.1:9777", () => order.push("old.close"));
    listenerMocks.start
      .mockImplementationOnce(async () => {
        order.push("old.start");
        return oldHandle;
      })
      .mockImplementationOnce(async () => {
        order.push("new.start");
        throw new Error("replacement failed");
      });
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });

    await service.start();
    await expect(service.reload()).rejects.toThrow("replacement failed");

    expect(order).toEqual(["old.start", "old.close", "new.start"]);
    expect(oldHandle.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.release).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toEqual({ state: "failed_closed", enabled: false });
    await service.close();
    expect(oldHandle.close).toHaveBeenCalledTimes(1);
  });

  it("reloads to disabled only after closing the active listener", async () => {
    enableEnvironment();
    const handle = listenerHandle("127.0.0.1:9888");
    listenerMocks.start.mockResolvedValue(handle);
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });
    await service.start();

    clearRemoteWorkerEnvironment();
    await expect(service.reload()).resolves.toEqual({ state: "disabled", enabled: false });

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.tryReserve).toHaveBeenCalledTimes(1);
  });

  it("does not bind a replacement when irreversible close is requested during reload teardown", async () => {
    enableEnvironment();
    let resolveOldClose: (() => void) | undefined;
    const oldHandle = listenerHandle("127.0.0.1:9999");
    oldHandle.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolveClose) => {
          resolveOldClose = resolveClose;
        }),
    );
    listenerMocks.start.mockResolvedValue(oldHandle);
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });
    await service.start();

    const reloading = service.reload();
    await vi.waitFor(() => expect(oldHandle.close).toHaveBeenCalledTimes(1));
    const closing = service.close();
    resolveOldClose?.();

    await expect(reloading).rejects.toBeInstanceOf(RemoteWorkerNativeRuntimeClosedError);
    await closing;
    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ state: "closed", enabled: false });
  });

  it("keeps terminal close failure truthful and does not retry or reopen", async () => {
    enableEnvironment();
    const closeError = new Error("listener close not confirmed");
    const handle = listenerHandle("127.0.0.1:9443");
    handle.close.mockRejectedValue(closeError);
    listenerMocks.start.mockResolvedValue(handle);
    const lifecycle = lifecycleMock();
    const service = createRemoteWorkerNativeRuntimeService({ sharedHostLifecycle: lifecycle.port });
    await service.start();

    const firstClose = service.close();
    await expect(firstClose).rejects.toBe(closeError);
    await expect(service.close()).rejects.toBe(closeError);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ state: "failed_closed", enabled: false });
    await expect(service.reload()).rejects.toBeInstanceOf(RemoteWorkerNativeRuntimeClosedError);
    expect(listenerMocks.start).toHaveBeenCalledTimes(1);
  });
});

function enableEnvironment(): void {
  const paths = {
    certificate: resolve("test-fixtures/worker-server.crt"),
    key: resolve("test-fixtures/worker-server.key"),
    ca: resolve("test-fixtures/worker-client-ca.crt"),
    signer: resolve("test-fixtures/manifest-signer.pem"),
  };
  Object.assign(process.env, {
    [REMOTE_WORKER_RUNTIME_ENV.enabled]: "true",
    [REMOTE_WORKER_RUNTIME_ENV.host]: "127.0.0.1",
    [REMOTE_WORKER_RUNTIME_ENV.port]: "9443",
    [REMOTE_WORKER_RUNTIME_ENV.serverCertificateFile]: paths.certificate,
    [REMOTE_WORKER_RUNTIME_ENV.serverKeyFile]: paths.key,
    [REMOTE_WORKER_RUNTIME_ENV.clientCaFile]: paths.ca,
    [REMOTE_WORKER_RUNTIME_ENV.clientCaSha256]: SHA_A,
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerKeyId]: "release-2026-07",
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerPublicKeyFile]: paths.signer,
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256]: SHA_B,
  });
}

function clearRemoteWorkerEnvironment(): void {
  for (const name of remoteWorkerEnvNames) delete process.env[name];
}

function listenerHandle(
  address: string,
  onClose?: () => void,
): RemoteWorkerNativeTlsListenerHandle & { close: ReturnType<typeof vi.fn> } {
  return {
    enabled: true,
    address,
    close: vi.fn(async () => onClose?.()),
  };
}

function lifecycleMock(signal: AbortSignal = new AbortController().signal): {
  port: SharedHostLifecycleAdmissionPort;
  tryReserve: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const reservation: SharedHostWorkReservation = {
    reservationId: "gateway:remote-worker-native-listener-startup",
    kind: "worker",
    admittedAt: "2026-07-15T00:00:00.000Z",
    signal,
    release,
  };
  const tryReserve = vi.fn(() => ({ admitted: true as const, reservation }));
  return {
    port: {
      tryReserve,
      snapshot: vi.fn(() => {
        throw new Error("snapshot is not used by the remote worker native runtime service");
      }),
    },
    tryReserve,
    release,
  };
}
