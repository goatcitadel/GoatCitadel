import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyActorContext, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool, type ToolExecutorRuntimeHooks } from "./tool-executor.js";

// agent.fanout is a pure dispatch case (R3-8): the child-turn spawning is
// impure gateway work, so — mirroring schedule.manage — the executor only
// routes the call to the subagentFanout runtime hook. No filesystem, network,
// or child-process mocks are needed here.

describe("tool executor — agent.fanout delegation (R3-8)", () => {
  it("routes agent.fanout to the subagentFanout runtime hook with the full invoke request", async () => {
    const policyContext: ToolPolicyActorContext = {
      operatorId: "op-1",
      authActorId: "op-1",
      permissionProfileId: "trusted_local_power",
    };
    const subagentFanout = vi.fn(async () => ({
      status: "completed",
      subtaskCount: 1,
      completedCount: 1,
      failedCount: 0,
      results: [],
    }));
    const request = fanoutRequest({ subtasks: [{ objective: "Research vendor A pricing" }] }, policyContext);

    const result = await executeTool(request, config(), storageStub(), {
      subagentFanout,
    } satisfies ToolExecutorRuntimeHooks);

    expect(subagentFanout).toHaveBeenCalledTimes(1);
    // The hook receives the whole request: the gateway resolves the active
    // turn executor by sessionId and needs args + policyContext + signal.
    expect(subagentFanout).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ status: "completed", subtaskCount: 1 });
  });

  it("fails closed when no subagentFanout hook is configured", async () => {
    await expect(
      executeTool(fanoutRequest({ subtasks: [{ objective: "Anything" }] }), config(), storageStub(), {}),
    ).rejects.toThrow(/agent\.fanout is not available/i);
  });
});

function fanoutRequest(args: Record<string, unknown>, policyContext?: ToolPolicyActorContext): ToolInvokeRequest {
  return {
    toolName: "agent.fanout",
    args,
    agentId: "assistant",
    sessionId: "session-fanout",
    ...(policyContext ? { policyContext } : {}),
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
  return {
    toolGrants: {
      listActiveBySession: vi.fn(() => []),
    },
  } as unknown as Storage & AsyncStorage;
}
