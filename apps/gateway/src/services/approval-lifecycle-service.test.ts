import { describe, expect, it, vi } from "vitest";
import { resolveChatToolApproval, type ApprovalLifecycleHost } from "./approval-lifecycle-service.js";

describe("resolveChatToolApproval", () => {
  it("uses the shared approval resolution wake result instead of double-waking the linked turn", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger",
      status: "pending",
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
      explanationStatus: "not_requested",
    };
    const resolvedApproval = {
      ...approval,
      status: "approved" as const,
      resolvedBy: "chat-operator",
      resolvedAt: new Date("2026-04-09T12:00:02.000Z").toISOString(),
    };

    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell.exec",
            status: "pending",
            reason: "Needs approval",
            createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            updatedAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            status: "waiting_for_approval",
            durable: {
              runId: "durable-turn-1",
            },
          })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        createGrant: vi.fn(),
      },
      resolveApproval: vi.fn(async () => ({
        approval: resolvedApproval,
        effects: [],
        replay: {
          approval: resolvedApproval,
          events: [],
          pendingAction: undefined,
          effects: [],
        },
        durableRunId: "approval-wait-1",
        resolutionEffects: {
          approvalWaitDurableRunId: "approval-wait-1",
          proactiveRunIds: [],
          chatTurnResume: {
            resumed: true,
            turnId: "turn-1",
            durableRunId: "durable-turn-1",
          },
        },
      })),
    } as unknown as ApprovalLifecycleHost;

    const result = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
    });

    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        resolvedBy: "chat-operator",
      }),
    );
    expect(result).toMatchObject({
      allowScope: "once",
      resumed: true,
      resumedTurnId: "turn-1",
      resumedRunId: "durable-turn-1",
    });
  });
});
