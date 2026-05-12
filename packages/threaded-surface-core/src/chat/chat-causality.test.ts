import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  createCorrelationId: vi.fn(() => "correlation-1"),
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  createCorrelationId: diagnostics.createCorrelationId,
  recordClientDiagnostic: diagnostics.recordClientDiagnostic,
}));

import {
  createChatExecutionCorrelationId,
  recordChatApprovalPhase,
  recordChatOutboundPhase,
  recordChatRefreshPhase,
} from "./chat-causality";

describe("chat-causality", () => {
  beforeEach(() => {
    diagnostics.createCorrelationId.mockClear();
    diagnostics.recordClientDiagnostic.mockClear();
  });

  it("delegates correlation id creation", () => {
    expect(createChatExecutionCorrelationId()).toBe("correlation-1");
    expect(diagnostics.createCorrelationId).toHaveBeenCalledTimes(1);
  });

  it("records outbound, approval, and refresh diagnostics with stable context", () => {
    recordChatOutboundPhase({
      phase: "provider_selected",
      action: "send",
      correlationId: "correlation-1",
      sessionId: "session-1",
      turnId: "turn-1",
      message: "Provider selected",
      context: { providerId: "openai" },
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "info",
      category: "chat",
      event: "outbound.provider_selected",
      message: "Provider selected",
      correlationId: "correlation-1",
      sessionId: "session-1",
      turnId: "turn-1",
      context: {
        action: "send",
        phase: "provider_selected",
        providerId: "openai",
      },
    });

    recordChatApprovalPhase({
      phase: "prompt_merged",
      sessionId: "session-1",
      turnId: "turn-1",
      correlationId: "correlation-1",
      source: "stream",
      approval: {
        approvalId: "approval-1",
        toolName: "fs.write",
        kind: "tool.invoke",
        reason: "Needs review",
        riskLevel: "danger",
        remainingCount: 2,
        affectedResourceCount: 1,
        requestedOutputIntent: "patch",
        expiresAt: "2026-05-04T12:00:00.000Z",
      },
      level: "warn",
      context: { queued: true },
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "warn",
      category: "chat",
      event: "approval.prompt_merged",
      message: "Approval prompt merged",
      correlationId: "correlation-1",
      sessionId: "session-1",
      turnId: "turn-1",
      context: {
        phase: "prompt_merged",
        source: "stream",
        approvalId: "approval-1",
        toolName: "fs.write",
        kind: "tool.invoke",
        reason: "Needs review",
        riskLevel: "danger",
        remainingCount: 2,
        affectedResourceCount: 1,
        requestedOutputIntent: "patch",
        expiresAt: "2026-05-04T12:00:00.000Z",
        queued: true,
      },
    });

    recordChatRefreshPhase({
      phase: "plan_resolved",
      sessionId: null,
      signal: { eventType: "chat_thread_updated", reason: "thread", source: "sse" },
      plan: { refreshSidebar: false, refreshSession: "full" },
      context: { local: false },
    });
    expect(diagnostics.recordClientDiagnostic).toHaveBeenLastCalledWith({
      level: "debug",
      category: "refresh",
      event: "refresh.plan_resolved",
      message: "Chat refresh plan resolved",
      sessionId: undefined,
      context: {
        phase: "plan_resolved",
        reason: "thread",
        eventType: "chat_thread_updated",
        source: "sse",
        refreshSidebar: false,
        refreshSession: "full",
        local: false,
      },
    });
  });
});
