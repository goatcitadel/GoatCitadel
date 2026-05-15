import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  createCorrelationId: vi.fn(() => "corr-test"),
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("../../state/dev-diagnostics-store", () => ({
  createCorrelationId: diagnostics.createCorrelationId,
  recordClientDiagnostic: diagnostics.recordClientDiagnostic,
}));

import {
  createChatExecutionCorrelationId,
  recordChatApprovalPhase,
  recordChatOutboundPhase,
  recordChatRefreshPhase,
} from "./chat-causality";

describe("chat causality diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates correlation id creation and records outbound phases with action context", () => {
    expect(createChatExecutionCorrelationId()).toBe("corr-test");

    recordChatOutboundPhase({
      phase: "provider_selected",
      action: "retry",
      correlationId: "corr-1",
      sessionId: "session-1",
      turnId: "turn-1",
      message: "Provider selected",
      level: "warn",
      context: {
        providerId: "openai",
      },
    });

    expect(diagnostics.recordClientDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "chat",
        event: "outbound.provider_selected",
        message: "Provider selected",
        correlationId: "corr-1",
        sessionId: "session-1",
        turnId: "turn-1",
        context: expect.objectContaining({
          action: "retry",
          phase: "provider_selected",
          providerId: "openai",
        }),
      }),
    );
  });

  it("records approval and refresh phases with safe defaults and merged context", () => {
    recordChatApprovalPhase({
      phase: "prompt_arrived",
      approval: {
        approvalId: "approval-1",
        toolName: "shell.exec",
        riskLevel: "danger",
        remainingCount: 2,
      },
      source: "queue",
      context: {
        queueDepth: 3,
      },
    });
    recordChatRefreshPhase({
      phase: "plan_applied",
      sessionId: null,
      signal: {
        eventType: "approval.resolved",
        reason: "approval resolved",
        source: "stream",
      },
      plan: {
        refreshSidebar: true,
        refreshSession: "full",
      },
      context: {
        approvalId: "approval-1",
      },
    });

    expect(diagnostics.recordClientDiagnostic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        level: "info",
        category: "chat",
        event: "approval.prompt_arrived",
        message: "Approval prompt arrived",
        context: expect.objectContaining({
          phase: "prompt_arrived",
          source: "queue",
          approvalId: "approval-1",
          toolName: "shell.exec",
          riskLevel: "danger",
          remainingCount: 2,
          queueDepth: 3,
        }),
      }),
    );
    expect(diagnostics.recordClientDiagnostic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        level: "debug",
        category: "refresh",
        event: "refresh.plan_applied",
        message: "Chat refresh plan applied",
        sessionId: undefined,
        context: expect.objectContaining({
          phase: "plan_applied",
          reason: "approval resolved",
          eventType: "approval.resolved",
          source: "stream",
          refreshSidebar: true,
          refreshSession: "full",
          approvalId: "approval-1",
        }),
      }),
    );
  });
});
