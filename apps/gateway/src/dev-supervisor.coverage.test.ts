import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NON_RETRYABLE_STARTUP_EXIT_CODE } from "./startup-errors.js";

// The supervisor persists its last-successful reference-build signature in
// node_modules/.cache so warm restarts can skip tsc -b. Each test in this file
// reimports the supervisor in a fresh vm, so we have to wipe that cache up front
// or the second test's reference-build assertion (`toHaveLength(1)`) collapses
// to zero because the persisted signature lets shouldBuildGatewayProjectReferences
// decide that nothing needs rebuilding.
const supervisorTestDir = path.dirname(fileURLToPath(import.meta.url));
const supervisorRefSignatureCacheFile = path.join(
  supervisorTestDir,
  "..",
  "node_modules",
  ".cache",
  "goatcitadel-dev",
  "ref-signature.json",
);

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
    process.exitCode = undefined;
    fs.rmSync(supervisorRefSignatureCacheFile, { force: true });

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
    process.exitCode = undefined;
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
    // The supervisor probes /livez (process-up signal) and /health (full readiness)
    // separately. This test exercises a health timeout + restart, so only the
    // /health-path matters for the assertion. Force /livez to always fail so it
    // never confuses the fetchCalls accounting; force /health to fail once,
    // then succeed.
    let healthFetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.endsWith("/livez")) {
          return new Response("ok", { status: 200 });
        }
        healthFetchCalls += 1;
        if (healthFetchCalls === 1) {
          throw new Error("not ready");
        }
        return new Response("ok", { status: 200 });
      }),
    );

    await import("./dev-supervisor.js");
    await new Promise((resolve) => setTimeout(resolve, 650));
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The reference build invocation may use the workspace runner, direct Node entrypoint,
    // or shell-free Corepack/pnpm fallback; all include the `-b tsconfig.json` flag in argv.
    const referenceBuildCalls = spawnSyncMock.mock.calls.filter((call) => {
      const args = Array.isArray(call[1]) ? call[1] : [];
      const joined = args.map(String).join(" ");
      return joined.includes("-b") && joined.includes("tsconfig.json");
    });
    expect(spawnMock).toHaveBeenCalled();
    expect(referenceBuildCalls).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[gateway-supervisor] fatal"));
  });

  it("stops waiting for readiness when the gateway exits during startup", async () => {
    process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS = "5000";
    process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS = "5000";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: () => boolean;
      };
      child.pid = 54321;
      child.kill = () => true;
      setTimeout(() => {
        child.emit("exit", 1, null);
      }, 0);
      return child;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("not ready");
      }),
    );

    const startedAt = Date.now();
    await import("./dev-supervisor.js");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        warnSpy.mock.calls.some((call) =>
          call.some((value) => String(value).includes("gateway exited before becoming healthy")),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gateway exited before becoming healthy"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("gateway did not become healthy in time"));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[gateway-supervisor] fatal"));
  });

  it("lets the startup waiter own an exit that occurs during the health request", async () => {
    process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS = "5000";
    process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS = "5000";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let spawnedChild: EventEmitter | undefined;

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: () => boolean;
      };
      child.pid = 56789;
      child.kill = () => true;
      spawnedChild = child;
      return child;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.endsWith("/livez")) {
          return new Response("ok", { status: 200 });
        }
        spawnedChild?.emit("exit", 1, null);
        return new Response("ok", { status: 200 });
      }),
    );

    await import("./dev-supervisor.js");
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gateway exited before becoming healthy"));
    });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("gateway online in"));
    expect(
      logSpy.mock.calls.filter((call) => call.some((value) => String(value).includes("scheduling restart"))),
    ).toHaveLength(1);

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("stops after one non-retryable startup exit instead of scheduling a loop", async () => {
    process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS = "5000";
    process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: () => boolean;
      };
      child.pid = 65432;
      child.kill = () => true;
      setTimeout(() => {
        child.emit("exit", NON_RETRYABLE_STARTUP_EXIT_CODE, null);
      }, 0);
      return child;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("not ready");
      }),
    );

    await import("./dev-supervisor.js");
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("gateway startup requires operator action; automatic restart disabled"),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(NON_RETRYABLE_STARTUP_EXIT_CODE);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("scheduling restart"));

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
