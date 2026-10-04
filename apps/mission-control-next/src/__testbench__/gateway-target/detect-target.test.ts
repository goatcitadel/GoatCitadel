import { describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { detectTarget, normalizeRootPath, type DevVerificationStatus } from "./detect-target";

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "C:\\Temp\\goatcitadel-usability-x\\",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const STATUS: DevVerificationStatus = { diagnosticsEnabled: true, rootDir: "c:/temp/goatcitadel-usability-x" };

function makeDeps(
  apiBase = "http://127.0.0.1:41873/",
  fetchStatus: () => Promise<DevVerificationStatus> = async () => STATUS,
) {
  return { apiBase, fetchStatus: vi.fn(fetchStatus) };
}

describe("detectTarget", () => {
  it("verifies the sandbox when origin and root both match", async () => {
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, makeDeps());
    expect(target).toEqual({
      kind: "sandbox",
      requested: "sandbox",
      origin: "http://127.0.0.1:41873",
      sandboxVerified: true,
      rootDir: STATUS.rootDir,
      reason: undefined,
    });
  });

  it("applies real rules without reading status when the real gateway was requested", async () => {
    const deps = makeDeps("http://127.0.0.1:8787");
    const target = await detectTarget({ requested: "real", origin: ENV.realOrigin }, ENV, deps);
    expect(target).toMatchObject({ kind: "real", requested: "real", sandboxVerified: false, reason: undefined });
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it("demotes to real rules when no sandbox was launched", async () => {
    const env: TestbenchEnv = { ...ENV, sandboxOrigin: undefined, sandboxRoot: undefined };
    const target = await detectTarget({ requested: "sandbox", origin: undefined }, env, makeDeps());
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("pnpm testbench");
  });

  it("demotes when the gateway is not the launched sandbox", async () => {
    const deps = makeDeps("http://127.0.0.1:8787");
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("is not the launched sandbox");
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it("demotes when the status endpoint fails", async () => {
    const deps = makeDeps(undefined, async () => {
      throw new Error("API error 404: Development verification endpoints are disabled.");
    });
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("Sandbox status is unavailable: API error 404");
  });

  it("demotes when the gateway root is not the launched root", async () => {
    const deps = makeDeps(undefined, async () => ({ diagnosticsEnabled: true, rootDir: "/elsewhere" }));
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target).toMatchObject({ kind: "real", sandboxVerified: false, rootDir: "/elsewhere" });
    expect(target.reason).toContain("is not the launched sandbox root");
  });

  it.each([undefined, 42, "  "])("demotes when the gateway reports no usable root (%j)", async (rootDir) => {
    const deps = makeDeps(
      undefined,
      async () => ({ diagnosticsEnabled: true, rootDir }) as unknown as DevVerificationStatus,
    );
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target).toMatchObject({ kind: "real", sandboxVerified: false, rootDir: undefined });
    expect(target.reason).toBe("The gateway did not report its runtime root, so it cannot be verified as the sandbox.");
  });
});

describe("normalizeRootPath", () => {
  it("compares Windows roots without regard to case, slash direction, or a trailing slash", () => {
    expect(normalizeRootPath("C:\\Temp\\X\\")).toBe(normalizeRootPath("c:/temp/x"));
  });
});
