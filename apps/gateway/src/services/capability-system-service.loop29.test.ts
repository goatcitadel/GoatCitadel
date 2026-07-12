import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { CapabilitySystemService } from "./capability-system-service.js";

describe("CapabilitySystemService loop 29 approval queue behavior", () => {
  it("marks expired durable approvals stale while preserving inline fallback details", () => {
    const expiredApproval: ApprovalRequest = {
      approvalId: "approval-expired",
      kind: "tool.invoke",
      riskLevel: "danger",
      status: "pending",
      payload: {},
      preview: {
        toolName: "shell.exec",
        description: "Run a risky command.",
        reason: "The command needs operator approval.",
      },
      linkage: { sessionId: "session-expired", toolName: "shell.exec" },
      createdAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const approvals = {
      get: vi.fn((approvalId: string) => {
        if (approvalId === expiredApproval.approvalId) {
          return expiredApproval;
        }
        throw new Error(`Missing approval ${approvalId}`);
      }),
    };
    const chatInlineApprovals = {
      listBySession: vi.fn(() => [
        {
          approvalId: expiredApproval.approvalId,
          sessionId: "session-expired",
          turnId: "turn-expired",
          status: "pending",
          kind: undefined,
          createdAt: "2026-05-01T00:00:01.000Z",
          expiresAt: undefined,
          details: {
            description: "Inline fallback description should lose to approval preview.",
          },
        },
      ]),
    };
    const service = new CapabilitySystemService({
      rootDir: "F:/tmp/goatcitadel-capability-loop29",
      runtimeConfig: {
        candidateRoot: "./data/capability-candidates",
        codeModeArtifactRoot: "./data/code-mode-artifacts",
        tempRoot: "./data/code-mode-temp",
        codeModeSandbox: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: false,
        },
      },
      storage: {
        approvals,
        chatInlineApprovals,
      } as never,
      readFeatureFlags: () => ({ codeModeV1Enabled: true }),
      listToolCatalog: () => [],
      listLoadedSkills: () => [],
      readSkillStates: () => new Map(),
      invokeTool: vi.fn(),
      createApproval: vi.fn(),
      resolveApproval: vi.fn(),
      publishRealtime: vi.fn(),
      readPolicySnapshot: () => ({}),
    });

    expect(service.listChatPendingApprovals("session-expired")).toEqual([
      expect.objectContaining({
        approvalId: "approval-expired",
        kind: "tool.invoke",
        toolName: "shell.exec",
        reason: "Inline fallback description should lose to approval preview.",
        riskLevel: "danger",
        expiresAt: "2000-01-01T00:00:00.000Z",
        stale: true,
        staleReason: "expired",
      }),
    ]);
  });
});
