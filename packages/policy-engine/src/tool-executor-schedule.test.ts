import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyActorContext, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool, type ToolExecutorRuntimeHooks } from "./tool-executor.js";

// schedule.manage is a pure dispatch case: it never touches the filesystem,
// network, or child processes — it just routes the call to the gateway runtime
// hook. So this suite needs no node:child_process / browser-tools mocks.

describe("tool executor — schedule.manage delegation (P1-F2)", () => {
  it("routes schedule.manage to the scheduleManage runtime hook with args + policy context", async () => {
    const policyContext: ToolPolicyActorContext = {
      operatorId: "op-1",
      authActorId: "op-1",
      permissionProfileId: "trusted_local_power",
    };
    const scheduleManage = vi.fn(async () => ({ op: "list", count: 0, jobs: [] }));
    const result = await executeTool(scheduleRequest({ op: "list" }, policyContext), config(), storageStub(), {
      scheduleManage,
    } satisfies ToolExecutorRuntimeHooks);

    expect(scheduleManage).toHaveBeenCalledTimes(1);
    expect(scheduleManage).toHaveBeenCalledWith({ op: "list" }, policyContext);
    expect(result).toMatchObject({ op: "list", count: 0, jobs: [] });
  });

  it("passes create args through to the hook unchanged", async () => {
    const scheduleManage = vi.fn(async () => ({ op: "create", jobId: "morning-x", enabled: true }));
    const args = { op: "create", name: "Morning", schedule: "0 9 * * 1-5", prompt: "Brief me" };
    const result = await executeTool(scheduleRequest(args), config(), storageStub(), { scheduleManage });

    expect(scheduleManage).toHaveBeenCalledWith(args, undefined);
    expect(result).toMatchObject({ op: "create", jobId: "morning-x" });
  });

  it("fails closed when no scheduleManage hook is configured", async () => {
    await expect(executeTool(scheduleRequest({ op: "list" }), config(), storageStub(), {})).rejects.toThrow(
      /schedule\.manage is not available/i,
    );
  });
});

function scheduleRequest(args: Record<string, unknown>, policyContext?: ToolPolicyActorContext): ToolInvokeRequest {
  return {
    toolName: "schedule.manage",
    args,
    agentId: "agent-schedule",
    sessionId: "session-schedule",
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
