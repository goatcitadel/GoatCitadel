import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool, type ToolExecutorRuntimeHooks } from "./tool-executor.js";

describe("tool executor - secure runtime configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates runtime.configure with bound request identity and returns only a fixed safe marker", async () => {
    const configureRuntime: NonNullable<ToolExecutorRuntimeHooks["configureRuntime"]> = vi.fn(async () => undefined);
    const request = runtimeConfigureRequest({ targetId: "search.brave" });

    const result = await executeTool(request, config(), storageStub(), { configureRuntime });

    expect(configureRuntime).toHaveBeenCalledWith(request, "search.brave");
    expect(result).toEqual({
      status: "configuration_required",
      configurationRequired: true,
      targetId: "search.brave",
    });
  });

  it.each([
    [{ targetId: "search.unknown" }, /supported secure configuration target/i],
    [{ targetId: "search.parallel", note: "configure this provider" }, /accepts only targetId/i],
    [{}, /accepts only targetId/i],
  ] as const)("rejects unsupported or additional runtime.configure arguments", async (args, message) => {
    const configureRuntime: NonNullable<ToolExecutorRuntimeHooks["configureRuntime"]> = vi.fn(async () => undefined);

    await expect(
      executeTool(runtimeConfigureRequest({ ...args }), config(), storageStub(), { configureRuntime }),
    ).rejects.toThrow(message);
    expect(configureRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when the Gateway-owned configuration hook is unavailable", async () => {
    await expect(
      executeTool(runtimeConfigureRequest({ targetId: "search.parallel" }), config(), storageStub()),
    ).rejects.toThrow(/secure runtime configuration is unavailable/i);
  });

  it("carries the protected credential resolver from ToolExecutorRuntimeHooks into official browser search", async () => {
    const resolveCredential = vi.fn(async () => "executor-brave-secret");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("executor-brave-secret");
      return Response.json({ web: { results: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      {
        toolName: "browser.search",
        args: { query: "current specification", backend: "official", providers: ["brave"] },
        agentId: "assistant",
        sessionId: "session-search",
        policyContext: { matchedGrantAllowedHosts: ["api.search.brave.com"] },
      },
      config(["api.search.brave.com"]),
      storageStub(),
      { resolveCredential },
    );

    expect(resolveCredential).toHaveBeenCalledWith("brave");
    expect(result).toMatchObject({ action: "search", backend: "official", backendUsed: true });
    expect(JSON.stringify(result)).not.toContain("executor-brave-secret");
  });
});

function runtimeConfigureRequest(args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName: "runtime.configure",
    args,
    agentId: "assistant",
    sessionId: "session-configure",
    workspaceId: "workspace-configure",
  };
}

function config(networkAllowlist: string[] = []): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function storageStub(): Storage & AsyncStorage {
  return {
    toolGrants: {
      listActiveBySession: vi.fn(() => []),
    },
  } as unknown as Storage & AsyncStorage;
}
