// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { loadTestbench, type TestbenchDeps } from "./use-testbench";

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/sandbox",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const SANDBOX_REQUEST: TargetRequest = { requested: "sandbox", origin: ENV.sandboxOrigin };

const HAND_WRITTEN: CheckDef[] = [
  {
    id: "demo.read",
    kind: "probe",
    domain: "health",
    title: "Demo read",
    tier: "read",
    routes: ["GET /api/v1/demo"],
    run: async () => pass("ok"),
  },
];

function makeDeps(overrides: Partial<TestbenchDeps> = {}): TestbenchDeps {
  return {
    apiBase: () => "http://127.0.0.1:41873",
    preflight: async () => ({ status: "ready", message: "Gateway ready." }),
    fetchStatus: async () => ({ diagnosticsEnabled: true, rootDir: "/tmp/sandbox" }),
    fetchManifest: async () => ({
      items: [
        { method: "GET", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "GET", url: "/api/v1/workspaces", tracked: true, accessClass: "operator" },
      ],
    }),
    seed: vi.fn(async () => ({ workspaceId: "ws-test" })),
    handWritten: HAND_WRITTEN,
    ...overrides,
  };
}

describe("loadTestbench", () => {
  it("verifies the sandbox, appends auto-probes, and keeps the tracked route keys", async () => {
    const load = await loadTestbench(SANDBOX_REQUEST, ENV, makeDeps());
    expect(load).toMatchObject({
      phase: "ready",
      target: { kind: "sandbox", sandboxVerified: true },
      manifestKeys: ["GET /api/v1/demo", "GET /api/v1/workspaces"],
      manifestError: undefined,
    });
    expect(load.phase === "ready" ? load.checks.map((check) => check.id) : []).toEqual([
      "demo.read",
      "auto:GET /api/v1/workspaces",
    ]);
  });

  it("explains gateways that need sign-in, are unreachable, or are misconfigured", async () => {
    await expect(
      loadTestbench(
        SANDBOX_REQUEST,
        ENV,
        makeDeps({ preflight: async () => ({ status: "needs-auth", message: "Token required." }) }),
      ),
    ).resolves.toMatchObject({ phase: "blocked", title: "This gateway needs you to sign in" });
    await expect(
      loadTestbench(
        SANDBOX_REQUEST,
        ENV,
        makeDeps({ preflight: async () => ({ status: "unreachable", message: "Network error." }) }),
      ),
    ).resolves.toMatchObject({
      phase: "blocked",
      title: "Gateway unreachable",
      detail: expect.stringContaining("port 5173"),
    });
    await expect(
      loadTestbench(
        SANDBOX_REQUEST,
        ENV,
        makeDeps({ preflight: async () => ({ status: "misconfigured", message: "Bad URL." }) }),
      ),
    ).resolves.toMatchObject({ phase: "blocked", title: "Gateway access is misconfigured", detail: "Bad URL." });
  });

  it("reports an unavailable route list without inventing coverage", async () => {
    const load = await loadTestbench(
      SANDBOX_REQUEST,
      ENV,
      makeDeps({
        fetchManifest: async () => {
          throw new Error("API error 404: Development verification endpoints are disabled.");
        },
      }),
    );
    expect(load).toMatchObject({
      phase: "ready",
      manifestKeys: undefined,
      manifestError: "API error 404: Development verification endpoints are disabled.",
    });
    expect(load.phase === "ready" ? load.checks.map((check) => check.id) : []).toEqual(["demo.read"]);
  });
});
