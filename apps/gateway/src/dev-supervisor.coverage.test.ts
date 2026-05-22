import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const createConnectionMock = vi.fn();
const statMock = vi.fn();
const readdirMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:net", () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

vi.mock("node:fs/promises", () => ({
  stat: statMock,
  readdir: readdirMock,
}));

vi.mock("./env-file.js", () => ({
  loadLocalEnvFile: () => {},
}));

function createSocketMock(): {
  once: (event: string, callback: () => void) => unknown;
  setTimeout: (_ms: number, callback: () => void) => unknown;
  destroy: () => void;
} {
  const socket = {
    once: (_event: string, callback: () => void) => {
      if (_event === "error") {
        setTimeout(() => callback(), 0);
      }
      return socket;
    },
    setTimeout: (_ms: number, callback: () => void) => {
      setTimeout(() => callback(), 0);
      return socket;
    },
    destroy: () => undefined,
  };
  return socket;
}

describe("dev supervisor coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    createConnectionMock.mockReset();
    statMock.mockReset();
    readdirMock.mockReset();

    process.env.GOATCITADEL_GATEWAY_WATCH_POLL_MS = "999999";
    delete process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS;
    delete process.env.GOATCITADEL_GATEWAY_REFERENCE_BUILD;
    delete process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS;
    process.env.GATEWAY_HOST = "127.0.0.1";
    process.env.GATEWAY_PORT = "8787";
    delete process.env.GOATCITADEL_AUTH_MODE;
    delete process.env.GOATCITADEL_AUTH_TOKEN;
    delete process.env.GOATCITADEL_ALLOW_UNAUTH_NETWORK;

    statMock.mockImplementation(async () => {
      throw new Error("not found");
    });
    readdirMock.mockResolvedValue([]);
    createConnectionMock.mockImplementation(() => createSocketMock());
    spawnSyncMock.mockReturnValue({ status: 0 });

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: () => boolean;
      };
      child.pid = 12345;
      child.kill = () => true;
      return child;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
  });

  afterEach(() => {
    delete process.env.GOATCITADEL_GATEWAY_WATCH_POLL_MS;
    delete process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS;
    delete process.env.GOATCITADEL_GATEWAY_REFERENCE_BUILD;
    delete process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS;
    delete process.env.GATEWAY_HOST;
    delete process.env.GATEWAY_PORT;
    delete process.env.GOATCITADEL_AUTH_MODE;
    delete process.env.GOATCITADEL_AUTH_TOKEN;
    delete process.env.GOATCITADEL_ALLOW_UNAUTH_NETWORK;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts and handles shutdown signal without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./dev-supervisor.js");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawnMock).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gateway child spawned in"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gateway online in"));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[gateway-supervisor] fatal"));
  });

  it("fails loudly for unauthenticated non-loopback binds instead of silently rewriting the host", async () => {
    process.env.GATEWAY_HOST = "0.0.0.0";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./dev-supervisor.js");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unsafe gateway bind blocked for local dev: GATEWAY_HOST=0.0.0.0"),
    );
  });

  it("does not repeat the reference build for an unchanged health-timeout restart", async () => {
    process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS = "1";
    process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          throw new Error("not ready");
        }
        return new Response("ok", { status: 200 });
      }),
    );

    await import("./dev-supervisor.js");
    await new Promise((resolve) => setTimeout(resolve, 650));
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const referenceBuildCalls = spawnSyncMock.mock.calls.filter((call) =>
      String(call[1]).includes("pnpm exec tsc -b tsconfig.json --pretty false"),
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(referenceBuildCalls).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[gateway-supervisor] fatal"));
  });
});
