import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { gatewayPlugin } from "./storage.js";
import { shouldStartDeferredInitInBackground, shouldStopBundledPostgresOnClose } from "./storage-runtime.js";

const startup = vi.hoisted(() => ({ create: vi.fn(), stop: vi.fn() }));
vi.mock("../config-files.js", () => ({ repoHasConfigMarker: () => true }));
vi.mock("../config.js", () => ({ loadGatewayConfig: async () => ({}) }));
vi.mock("../bundled-postgres-runtime.js", () => ({
  ensureBundledPostgresRuntime: async () => ({ stop: startup.stop }),
  startInstalledNativePostgresRecovery: () => undefined,
}));
vi.mock("../services/gateway-runtime-factory.js", () => ({ createGatewayRuntime: startup.create }));

describe("Gateway storage startup", () => {
  it.each(["construction", "critical initialization"])("cleans up owned resources after failed %s", async (stage) => {
    const app = Fastify();
    const failure = new Error("startup failed");
    const close = vi.fn().mockResolvedValue(undefined);
    startup.stop.mockReset().mockResolvedValue(undefined);
    startup.create.mockImplementation(() => {
      if (stage === "construction") throw failure;
      return {
        attachDevDiagnosticsLogger: vi.fn(),
        initCritical: vi.fn().mockRejectedValue(failure),
        close,
      };
    });
    vi.stubEnv("GOATCITADEL_GATEWAY_SUPERVISED", "0");
    try {
      app.register(gatewayPlugin);
      await expect(app.ready()).rejects.toBe(failure);
      expect(close).toHaveBeenCalledTimes(stage === "construction" ? 0 : 1);
      expect(startup.stop).toHaveBeenCalledTimes(1);
    } finally {
      try {
        await app.close();
      } finally {
        vi.unstubAllEnvs();
      }
    }
    expect(startup.stop).toHaveBeenCalledTimes(1);
  });
});

describe("shouldStopBundledPostgresOnClose", () => {
  it("keeps bundled Postgres running for supervised dev restarts", () => {
    expect(shouldStopBundledPostgresOnClose("1")).toBe(false);
  });

  it("stops bundled Postgres when the gateway is not supervisor-managed", () => {
    expect(shouldStopBundledPostgresOnClose(undefined)).toBe(true);
    expect(shouldStopBundledPostgresOnClose("0")).toBe(true);
  });
});

describe("shouldStartDeferredInitInBackground", () => {
  it("only backgrounds deferred startup for supervised dev restarts", () => {
    expect(shouldStartDeferredInitInBackground("1")).toBe(true);
    expect(shouldStartDeferredInitInBackground(undefined)).toBe(false);
    expect(shouldStartDeferredInitInBackground("0")).toBe(false);
  });
});
