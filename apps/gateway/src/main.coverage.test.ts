import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedProcessHandler = (...args: unknown[]) => void;

interface MockGatewayApp {
  close: ReturnType<typeof vi.fn>;
  gatewayConfig: {
    assistant: {
      auth: {
        mode: string;
      };
    };
  };
  listen: ReturnType<typeof vi.fn>;
  log: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  services: {
    a2a: unknown;
  };
  server: {
    close: ReturnType<typeof vi.fn>;
    listening: boolean;
  };
  sharedHostLifecycle: ReturnType<typeof createSharedHostLifecycleMock>;
}

interface MockA2AGrpcServer {
  close: ReturnType<typeof vi.fn>;
  enabled: boolean;
}

interface MockRemoteWorkerNativeRuntime {
  close: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

function createSharedHostLifecycleMock() {
  return {
    markClosed: vi.fn(),
    tryReserve: vi.fn(() => ({
      admitted: true as const,
      state: "accepting" as const,
      reservation: {
        signal: new AbortController().signal,
        release: vi.fn(),
      },
    })),
  };
}

const importMainWithMocks = async (
  options: {
    app?: MockGatewayApp;
    allowUnauthNetwork?: boolean;
    buildAppError?: Error;
    grpcServer?: MockA2AGrpcServer;
    grpcStartError?: Error;
    host?: string;
    remoteWorkerStartError?: Error;
    shouldWarnUnsafeBind?: boolean;
    terminalTask?: string;
    warnUnauthNonLoopback?: boolean;
  } = {},
) => {
  vi.resetModules();

  const handlers = new Map<string, CapturedProcessHandler[]>();
  const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    const eventName = String(event);
    const captured = handlers.get(eventName) ?? [];
    captured.push(listener as CapturedProcessHandler);
    handlers.set(eventName, captured);
    return process;
  });

  const app =
    options.app ??
    ({
      close: vi.fn(async () => undefined),
      gatewayConfig: {
        assistant: {
          auth: {
            mode: "none",
          },
        },
      },
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      services: {
        a2a: {},
      },
      server: {
        close: vi.fn(),
        listening: false,
      },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp);
  const setGoatcitadelTerminalTitle = vi.fn();
  const grpcServer =
    options.grpcServer ??
    ({
      close: vi.fn(async () => undefined),
      enabled: false,
    } satisfies MockA2AGrpcServer);
  const startA2AGrpcServer = vi.fn(async () => {
    if (options.grpcStartError !== undefined) throw options.grpcStartError;
    return grpcServer;
  });
  const remoteWorkerNativeRuntime: MockRemoteWorkerNativeRuntime = {
    close: vi.fn(async () => undefined),
    reload: vi.fn(async () => ({ enabled: false, state: "disabled" })),
    snapshot: vi.fn(() => ({ enabled: false, state: "uninitialized" })),
    start: vi.fn(async () => {
      if (options.remoteWorkerStartError !== undefined) throw options.remoteWorkerStartError;
      return { enabled: false, state: "disabled" };
    }),
  };
  const createRemoteWorkerNativeRuntimeService = vi.fn(() => remoteWorkerNativeRuntime);

  vi.doMock("./app.js", () => ({
    buildApp: vi.fn(async () => {
      if (options.buildAppError) {
        throw options.buildAppError;
      }
      return app;
    }),
  }));
  vi.doMock("./env.js", () => ({
    env: {
      GATEWAY_HOST: options.host ?? "127.0.0.1",
      GATEWAY_PORT: 8787,
      GOATCITADEL_TERMINAL_TASK: options.terminalTask,
    },
  }));
  vi.doMock("./runtime-ux.js", () => ({
    setGoatcitadelTerminalTitle,
  }));
  vi.doMock("./services/a2a-grpc-server.js", () => ({
    startA2AGrpcServer,
  }));
  vi.doMock("./services/remote-worker-native-runtime-service.js", () => ({
    createRemoteWorkerNativeRuntimeService,
  }));
  vi.doMock("./startup-guard.js", () => ({
    INSECURE_LOCAL_ONLY_OVERRIDE_ENV: "GOATCITADEL_ALLOW_UNAUTHENTICATED_NETWORK",
    resolveAllowUnauthNetwork: vi.fn(() => options.allowUnauthNetwork ?? false),
    resolveWarnUnauthNonLoopback: vi.fn(() => options.warnUnauthNonLoopback ?? false),
    shouldWarnUnauthNonLoopbackBind: vi.fn(() => options.shouldWarnUnsafeBind ?? false),
  }));

  await import("./main.js");

  return {
    app,
    createRemoteWorkerNativeRuntimeService,
    grpcServer,
    handlers,
    onSpy,
    remoteWorkerNativeRuntime,
    setGoatcitadelTerminalTitle,
    startA2AGrpcServer,
  };
};

describe("gateway main entrypoint", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  it("registers warning and shutdown handlers around a successful listen", async () => {
    const {
      app,
      createRemoteWorkerNativeRuntimeService,
      handlers,
      remoteWorkerNativeRuntime,
      setGoatcitadelTerminalTitle,
      startA2AGrpcServer,
    } = await importMainWithMocks({ terminalTask: " Gateway Dev " });

    expect(setGoatcitadelTerminalTitle).toHaveBeenCalledWith("Gateway Dev");
    expect(createRemoteWorkerNativeRuntimeService).toHaveBeenCalledWith({
      sharedHostLifecycle: app.sharedHostLifecycle,
    });
    expect(remoteWorkerNativeRuntime.start).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8787 });
    expect(app.log.info).toHaveBeenCalledWith("gateway listening on http://127.0.0.1:8787");
    expect(startA2AGrpcServer).toHaveBeenCalledWith({
      a2a: app.services.a2a,
      config: app.gatewayConfig,
      logger: app.log,
      sharedHostLifecycle: app.sharedHostLifecycle,
    });
    expect(remoteWorkerNativeRuntime.start.mock.invocationCallOrder[0]).toBeLessThan(
      app.listen.mock.invocationCallOrder[0] as number,
    );
    expect(app.listen.mock.invocationCallOrder[0]).toBeLessThan(
      startA2AGrpcServer.mock.invocationCallOrder[0] as number,
    );

    handlers.get("warning")?.[0]?.(
      Object.assign(new Error("deprecated option"), {
        code: "DEP_TEST",
        name: "DeprecationWarning",
      }),
    );
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "DEP_TEST",
        detail: "deprecated option",
        warningName: "DeprecationWarning",
      }),
      "node warning: DeprecationWarning",
    );

    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(app.close).toHaveBeenCalledTimes(1));
    expect(remoteWorkerNativeRuntime.close).toHaveBeenCalledTimes(1);
    expect(app.log.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "shutting down gateway");
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
  });

  it("defaults the terminal title, ignores repeated shutdown, and forces exit after timeout", async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = {
      close: vi.fn(() => new Promise(() => undefined)),
      gatewayConfig: {
        assistant: {
          auth: {
            mode: "none",
          },
        },
      },
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      services: {
        a2a: {},
      },
      server: {
        close: vi.fn(),
        listening: false,
      },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp;
    const { handlers, setGoatcitadelTerminalTitle } = await importMainWithMocks({
      app,
      terminalTask: "   ",
    });

    expect(setGoatcitadelTerminalTitle).toHaveBeenCalledWith("Gateway");
    handlers.get("SIGINT")?.[0]?.();
    handlers.get("SIGINT")?.[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.close).toHaveBeenCalledTimes(1);

    expect(() => vi.advanceTimersByTime(10_000)).toThrow("process.exit:1");
    expect(consoleError).toHaveBeenCalledWith("[gateway] graceful shutdown timed out after 10 s — forcing exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("records shutdown close failures without forcing an immediate process exit", async () => {
    const shutdownError = new Error("close failed");
    const app = {
      close: vi.fn(async () => {
        throw shutdownError;
      }),
      gatewayConfig: {
        assistant: {
          auth: {
            mode: "none",
          },
        },
      },
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      services: {
        a2a: {},
      },
      server: {
        close: vi.fn(),
        listening: false,
      },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp;
    const { handlers } = await importMainWithMocks({ app });

    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(app.log.error).toHaveBeenCalledWith(shutdownError, "gateway shutdown failed"));
    expect(process.exitCode).toBe(1);
  });

  it("logs startup failures and exits with failure code", async () => {
    const exitSpy = vi.spyOn(process, "exit");
    const app = {
      close: vi.fn(async () => undefined),
      gatewayConfig: {
        assistant: {
          auth: {
            mode: "none",
          },
        },
      },
      listen: vi.fn(async () => {
        throw new Error("port already in use");
      }),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      services: {
        a2a: {},
      },
      server: {
        close: vi.fn(),
        listening: false,
      },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp;

    const { remoteWorkerNativeRuntime } = await importMainWithMocks({ app });

    expect(app.log.error).toHaveBeenCalledWith(expect.objectContaining({ message: "port already in use" }));
    expect(remoteWorkerNativeRuntime.close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rolls back the production-dark listener when A2A startup fails", async () => {
    const grpcError = new Error("A2A bind failed");
    const app = {
      close: vi.fn(async () => undefined),
      gatewayConfig: { assistant: { auth: { mode: "token" } } },
      listen: vi.fn(async () => undefined),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      services: { a2a: {} },
      server: { close: vi.fn(), listening: false },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp;
    const failing = await importMainWithMocks({ app, grpcStartError: grpcError });

    expect(failing.remoteWorkerNativeRuntime.start).toHaveBeenCalledTimes(1);
    expect(failing.remoteWorkerNativeRuntime.close).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(app.log.error).toHaveBeenCalledWith(grpcError);
    expect(process.exitCode).toBe(1);
  });

  it("fails before HTTP bind and closes the runtime owner when native listener startup fails", async () => {
    const startError = new Error("remote worker listener failed");
    const app = {
      close: vi.fn(async () => undefined),
      gatewayConfig: { assistant: { auth: { mode: "token" } } },
      listen: vi.fn(async () => undefined),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      services: { a2a: {} },
      server: { close: vi.fn(), listening: false },
      sharedHostLifecycle: createSharedHostLifecycleMock(),
    } satisfies MockGatewayApp;
    const failing = await importMainWithMocks({ app, remoteWorkerStartError: startError });

    expect(failing.remoteWorkerNativeRuntime.start).toHaveBeenCalledTimes(1);
    expect(failing.remoteWorkerNativeRuntime.close).toHaveBeenCalledTimes(1);
    expect(app.listen).not.toHaveBeenCalled();
    expect(failing.startA2AGrpcServer).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(app.log.error).toHaveBeenCalledWith(startError);
    expect(process.exitCode).toBe(1);
  });
});
