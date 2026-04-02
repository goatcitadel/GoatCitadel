import { describe, expect, it, vi } from "vitest";

vi.mock("sqlite", () => ({}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

function createGatewayHarness(workspaceId = "default") {
  const gateway: any = Object.create(GatewayService.prototype);
  gateway.getSession = vi.fn((sessionId: string) => ({ sessionId }));
  gateway.normalizeWorkspaceId = vi.fn((value?: string) => value?.trim() || "default");
  gateway.runMemoryMaintenanceNow = vi.fn();
  gateway.getMemoryMaintenanceStatus = vi.fn();
  gateway.getSettings = vi.fn(() => ({
    llm: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
    },
  }));
  gateway.storage = {
    chatSessionMeta: {
      ensure: vi.fn(() => ({ workspaceId })),
    },
  };
  return gateway;
}

describe("GatewayService /dream command flow", () => {
  it("queues a manual Dream run for the current session workspace", async () => {
    const gateway = createGatewayHarness(" workspace-alpha ");
    gateway.runMemoryMaintenanceNow.mockReturnValue({
      runId: "mmrun_123",
      workspaceId: "workspace-alpha",
      triggerSource: "manual",
      status: "queued",
    });

    const result = await GatewayService.prototype.parseChatCommand.call(gateway, "sess-1", "/dream");

    expect(result).toMatchObject({
      ok: true,
      command: "/dream",
      message: "Memory maintenance queued for workspace-alpha (mmrun_123).",
    });
    expect(gateway.runMemoryMaintenanceNow).toHaveBeenCalledWith({
      workspaceId: "workspace-alpha",
      triggerSource: "manual",
    });
  });

  it("reports pinned model, execution target, and schedule in /dream status", async () => {
    const gateway = createGatewayHarness("default");
    gateway.getMemoryMaintenanceStatus.mockReturnValue({
      workspaceId: "default",
      policy: {
        enabled: true,
        runMode: "hybrid",
        timingStrategy: "recommendation_first",
        providerId: "ollama",
        model: "qwen3",
        executionTarget: "local",
        unavailableModelPolicy: "skip",
        timeZone: "America/Los_Angeles",
        schedule: {
          frequency: "daily",
          hour: 3,
          minute: 0,
        },
      },
      state: {
        changedSessionCount: 4,
      },
      lastRun: {
        status: "completed",
        updatedAt: "2026-04-01T09:02:00.000Z",
      },
      nextDueAt: "2026-04-02T10:00:00.000Z",
    });

    const result = await GatewayService.prototype.parseChatCommand.call(gateway, "sess-1", "/dream status");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Mode: hybrid / recommendation_first");
    expect(result.message).toContain("Provider/model: ollama/qwen3 (pinned)");
    expect(result.message).toContain("Execution target: local (skip if unavailable)");
    expect(result.message).toContain("Schedule: daily 03:00 America/Los_Angeles");
    expect(result.message).toContain("Changed sessions: 4");
    expect(result.message).toContain("Next due: 2026-04-02T10:00:00.000Z");
  });
});
