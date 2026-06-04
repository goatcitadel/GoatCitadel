import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildAppMock = vi.fn();
const shouldWarnMock = vi.fn();
const resolveWarnMock = vi.fn();
const resolveAllowMock = vi.fn();
const startA2AGrpcServerMock = vi.fn();

vi.mock("./app.js", () => ({
  buildApp: buildAppMock,
}));

vi.mock("./startup-guard.js", () => ({
  shouldWarnUnauthNonLoopbackBind: shouldWarnMock,
  resolveWarnUnauthNonLoopback: resolveWarnMock,
  resolveAllowUnauthNetwork: resolveAllowMock,
}));

vi.mock("./services/a2a-grpc-server.js", () => ({
  startA2AGrpcServer: startA2AGrpcServerMock,
}));

describe("gateway main entrypoint coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    buildAppMock.mockReset();
    shouldWarnMock.mockReset();
    resolveWarnMock.mockReset();
    resolveAllowMock.mockReset();
    startA2AGrpcServerMock.mockReset();
    startA2AGrpcServerMock.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      enabled: false,
    });
    delete process.env.GATEWAY_HOST;
    delete process.env.GATEWAY_PORT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts listening when bind is safe", async () => {
    const listenMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const infoMock = vi.fn();
    const warnMock = vi.fn();
    const errorMock = vi.fn();

    buildAppMock.mockResolvedValue({
      gatewayConfig: {
        assistant: {
          auth: { mode: "token" },
        },
      },
      listen: listenMock,
      close: closeMock,
      log: {
        info: infoMock,
        warn: warnMock,
        error: errorMock,
      },
      services: {
        a2a: {},
      },
    });
    shouldWarnMock.mockReturnValue(false);
    resolveWarnMock.mockReturnValue(true);
    resolveAllowMock.mockReturnValue(false);

    await import("./main.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(startA2AGrpcServerMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("allows unsafe bind only when override is enabled and emits warning", async () => {
    const listenMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const infoMock = vi.fn();
    const warnMock = vi.fn();
    const errorMock = vi.fn();

    buildAppMock.mockResolvedValue({
      gatewayConfig: {
        assistant: {
          auth: { mode: "none" },
        },
      },
      listen: listenMock,
      close: closeMock,
      log: {
        info: infoMock,
        warn: warnMock,
        error: errorMock,
      },
      services: {
        a2a: {},
      },
    });
    shouldWarnMock.mockReturnValue(true);
    resolveWarnMock.mockReturnValue(true);
    resolveAllowMock.mockReturnValue(true);

    await import("./main.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnMock).toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(startA2AGrpcServerMock).toHaveBeenCalledTimes(1);
  });

  it("hard exits when unsafe bind is blocked", async () => {
    const listenMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const infoMock = vi.fn();
    const warnMock = vi.fn();
    const errorMock = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    buildAppMock.mockResolvedValue({
      gatewayConfig: {
        assistant: {
          auth: { mode: "none" },
        },
      },
      listen: listenMock,
      close: closeMock,
      log: {
        info: infoMock,
        warn: warnMock,
        error: errorMock,
      },
      services: {
        a2a: {},
      },
    });
    shouldWarnMock.mockReturnValue(true);
    resolveWarnMock.mockReturnValue(true);
    resolveAllowMock.mockReturnValue(false);

    await import("./main.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("hard exits when listen fails", async () => {
    const listenMock = vi.fn().mockRejectedValue(new Error("listen failed"));
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const infoMock = vi.fn();
    const warnMock = vi.fn();
    const errorMock = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    buildAppMock.mockResolvedValue({
      gatewayConfig: {
        assistant: {
          auth: { mode: "token" },
        },
      },
      listen: listenMock,
      close: closeMock,
      log: {
        info: infoMock,
        warn: warnMock,
        error: errorMock,
      },
      services: {
        a2a: {},
      },
    });
    shouldWarnMock.mockReturnValue(false);
    resolveWarnMock.mockReturnValue(true);
    resolveAllowMock.mockReturnValue(false);

    await import("./main.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
