import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  createCorrelationId: vi.fn(() => "correlation-loop-26"),
  recordClientDiagnostic: diagnostics.recordClientDiagnostic,
}));

import { recordChatApprovalPhase, recordChatOutboundPhase, recordChatRefreshPhase } from "./chat-causality";

describe("chat-causality loop 26 defaults", () => {
  beforeEach(() => {
    diagnostics.recordClientDiagnostic.mockClear();
  });

  it("records default levels and omitted optional contexts without widening payloads", () => {
    recordChatOutboundPhase({
      phase: "failed",
      action: "retry",
      correlationId: "correlation-loop-26",
      message: "Retry failed",
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "info",
      category: "chat",
      event: "outbound.failed",
      message: "Retry failed",
      correlationId: "correlation-loop-26",
      sessionId: undefined,
      turnId: undefined,
      context: {
        action: "retry",
        phase: "failed",
      },
    });

    recordChatApprovalPhase({
      phase: "dismissed",
      approval: { approvalId: "approval-loop-26" },
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "info",
      category: "chat",
      event: "approval.dismissed",
      message: "Approval dismissed",
      correlationId: undefined,
      sessionId: undefined,
      turnId: undefined,
      context: {
        phase: "dismissed",
        source: undefined,
        approvalId: "approval-loop-26",
        toolName: undefined,
        kind: undefined,
        reason: undefined,
        riskLevel: undefined,
        remainingCount: undefined,
        affectedResourceCount: undefined,
        requestedOutputIntent: undefined,
        expiresAt: undefined,
      },
    });

    recordChatRefreshPhase({
      phase: "plan_completed",
      signal: { eventType: undefined, reason: "fallback", source: undefined },
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "debug",
      category: "refresh",
      event: "refresh.plan_completed",
      message: "Chat refresh plan completed",
      sessionId: undefined,
      context: {
        phase: "plan_completed",
        reason: "fallback",
        eventType: undefined,
        source: undefined,
        refreshSidebar: undefined,
        refreshSession: undefined,
      },
    });
  });
});
