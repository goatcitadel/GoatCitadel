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
}

const importMainWithMocks = async (
  options: {
    app?: MockGatewayApp;
    allowUnauthNetwork?: boolean;
    buildAppError?: Error;
    host?: string;
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
    } satisfies MockGatewayApp);
  const setGoatcitadelTerminalTitle = vi.fn();

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
  vi.doMock("./startup-guard.js", () => ({
    INSECURE_LOCAL_ONLY_OVERRIDE_ENV: "GOATCITADEL_ALLOW_UNAUTHENTICATED_NETWORK",
    resolveAllowUnauthNetwork: vi.fn(() => options.allowUnauthNetwork ?? false),
    resolveWarnUnauthNonLoopback: vi.fn(() => options.warnUnauthNonLoopback ?? false),
    shouldWarnUnauthNonLoopbackBind: vi.fn(() => options.shouldWarnUnsafeBind ?? false),
  }));

  await import("./main.js");

  return { app, handlers, onSpy, setGoatcitadelTerminalTitle };
};

describe("gateway main entrypoint", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  it("registers warning and shutdown handlers around a successful listen", async () => {
    const { app, handlers, setGoatcitadelTerminalTitle } = await importMainWithMocks({
      terminalTask: " Gateway Dev ",
    });

    expect(setGoatcitadelTerminalTitle).toHaveBeenCalledWith("Gateway Dev");
    expect(app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8787 });
    expect(app.log.info).toHaveBeenCalledWith("gateway listening on http://127.0.0.1:8787");

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
    } satisfies MockGatewayApp;
    const { handlers, setGoatcitadelTerminalTitle } = await importMainWithMocks({
      app,
      terminalTask: "   ",
    });

    expect(setGoatcitadelTerminalTitle).toHaveBeenCalledWith("Gateway");
    handlers.get("SIGINT")?.[0]?.();
    handlers.get("SIGINT")?.[0]?.();
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
    } satisfies MockGatewayApp;
    const { handlers } = await importMainWithMocks({ app });

    handlers.get("SIGTERM")?.[0]?.();
    await vi.waitFor(() => expect(app.log.error).toHaveBeenCalledWith(shutdownError, "gateway shutdown failed"));
    expect(process.exitCode).toBe(1);
  });

  it("logs startup failures and exits with failure code", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    });
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
    } satisfies MockGatewayApp;

    await expect(importMainWithMocks({ app })).rejects.toThrow("process.exit:1");

    expect(app.log.error).toHaveBeenCalledWith(expect.objectContaining({ message: "port already in use" }));
    expect(process.exitCode).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
