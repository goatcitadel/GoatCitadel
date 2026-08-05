import { describe, expect, it, vi } from "vitest";
import { ResearchService } from "./research-service.js";

describe("ResearchService policy context", () => {
  it("passes parent run and task policy lineage into browser search", async () => {
    const create = vi.fn();
    const patch = vi.fn();
    const replaceForRun = vi.fn(() => []);
    const invokeTool = vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "ok",
      auditEventId: "audit-1",
      result: { results: [] },
    }));
    const resolveToolPolicyContext = vi.fn(async (input) => ({
      ...input,
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      permissionProfile: {
        profileId: "profile-1",
        label: "Test",
        builtin: false,
        status: "active",
        scope: "workspace",
        approvalMode: "approve_all",
        toolPatterns: ["browser.search"],
        allow: [],
        deny: [],
        createdBy: "operator-1",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
    }));
    const service = new ResearchService({
      storage: {
        researchRuns: { create, patch },
        researchSources: { replaceForRun },
        chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-1" })) },
      } as never,
      invokeTool,
      createChatCompletion: vi.fn(async () => ({
        choices: [{ message: { role: "assistant", content: "No sources." } }],
      })),
      resolveToolPolicyContext,
    });

    await service.run({
      sessionId: "session-1",
      query: "policy lineage",
      mode: "quick",
      workspaceId: "workspace-1",
      policyRunId: "parent-run-1",
      policyTaskId: "parent-task-1",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
    });

    expect(resolveToolPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "parent-run-1",
        taskId: "parent-task-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        surface: "cowork",
      }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        workspaceId: "workspace-1",
        runId: "parent-run-1",
        taskId: "parent-task-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      }),
    );
  });
});
