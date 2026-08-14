import { describe, expect, it, vi } from "vitest";
import type { ChangePlanModelToolResult, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool, type ToolExecutorRuntimeHooks } from "./tool-executor.js";

describe("tool executor - Change Plan request", () => {
  it("delegates a bounded intent and returns only the model-safe plan projection", async () => {
    const requestChangePlan: NonNullable<ToolExecutorRuntimeHooks["requestChangePlan"]> = vi.fn(
      async (): Promise<ChangePlanModelToolResult> => ({
        planId: "plan-1",
        status: "awaiting_confirmation",
        requiredAction: "confirmation",
      }),
    );
    const request = changeRequest({
      intent: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
    });

    const result = await executeTool(request, config(), storageStub(), { requestChangePlan });

    expect(requestChangePlan).toHaveBeenCalledWith(request, request.args.intent);
    expect(result).toEqual({ planId: "plan-1", status: "awaiting_confirmation", requiredAction: "confirmation" });
    expect(JSON.stringify(result)).not.toMatch(/nonce|secret|path|patch/iu);
  });

  it.each([
    [{}, /accepts only intent/i],
    [{ intent: { kind: "session_model", model: "gpt-5" }, note: "apply it" }, /accepts only intent/i],
    [{ intent: { kind: "managed_source_registration", path: "F:/code/personal-ai" } }, /allowlisted bounded/i],
    [
      { intent: { kind: "product_source_update", sourceInstallId: "install-1", patch: "diff --git" } },
      /allowlisted bounded/i,
    ],
    [{ intent: { kind: "runtime_configuration", key: "anything", value: true } }, /allowlisted bounded/i],
  ] as const)("rejects unbounded or effect-bearing model arguments", async (args, message) => {
    const requestChangePlan: NonNullable<ToolExecutorRuntimeHooks["requestChangePlan"]> = vi.fn();
    await expect(
      executeTool(changeRequest({ ...args }), config(), storageStub(), { requestChangePlan }),
    ).rejects.toThrow(message);
    expect(requestChangePlan).not.toHaveBeenCalled();
  });

  it("fails closed when the Gateway Change Plan owner is unavailable", async () => {
    await expect(
      executeTool(
        changeRequest({ intent: { kind: "provider_connection", providerId: "openai" } }),
        config(),
        storageStub(),
      ),
    ).rejects.toThrow(/unavailable/i);
  });
});

function changeRequest(args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName: "change.request",
    args,
    agentId: "assistant",
    sessionId: "session-1",
    turnId: "turn-1",
    toolRunId: "tool-run-1",
    workspaceId: "default",
    surface: "chat",
    policyContext: { surface: "chat", workspaceId: "default", sessionId: "session-1", authActorSource: "loopback" },
  };
}

function config(): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function storageStub(): Storage & AsyncStorage {
  return { toolGrants: { listActiveBySession: vi.fn(() => []) } } as unknown as Storage & AsyncStorage;
}
