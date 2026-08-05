import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeTool } from "./tool-executor.js";

describe("notify.request tool execution", () => {
  it("delegates only event content and server-owned session identity to the Gateway hook", async () => {
    const requestNotification = vi.fn(async () => ({ eventId: "event-1", deliveryCount: 1 }));
    const request: ToolInvokeRequest = {
      toolName: "notify.request",
      sessionId: "session-1",
      agentId: "agent-1",
      args: { eventType: "durable.attention_required", title: "Review", message: "A decision is needed." },
    };
    const result = await executeTool(request, config(), storage(), { requestNotification });
    expect(requestNotification).toHaveBeenCalledWith(request, {
      eventType: "durable.attention_required",
      title: "Review",
      message: "A decision is needed.",
    });
    expect(result).toMatchObject({ eventId: "event-1" });
  });

  it("fails closed without a Gateway notification owner", async () => {
    await expect(
      executeTool(
        {
          toolName: "notify.request",
          sessionId: "session-1",
          agentId: "agent-1",
          args: { eventType: "turn.failed", title: "Failed", message: "Inspect trace." },
        },
        config(),
        storage(),
      ),
    ).rejects.toThrow(/unavailable/i);
  });
});

function config(): ToolPolicyConfig {
  return {
    profiles: { standard: ["*"] },
    tools: { profile: "standard", allow: [], deny: [] },
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

function storage(): Storage & AsyncStorage {
  return { toolGrants: { listActiveBySession: vi.fn(() => []) } } as unknown as Storage & AsyncStorage;
}
