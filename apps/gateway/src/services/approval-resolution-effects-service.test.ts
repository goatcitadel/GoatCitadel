import type {
  ApprovalRequest,
  ChatTurnTraceRecord,
  DurableRunRecord,
  RealtimeEvent,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyApprovalResolutionWakeEffects } from "./approval-resolution-effects-service.js";

describe("approval-resolution-effects-service", () => {
  it("wakes the approval wait run, linked proactive runs, and linked chat turn exactly once", () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger",
      status: "approved" as const,
      linkage: {
        turnId: "turn-1",
      },
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: "2026-04-10T00:00:00.000Z",
      resolvedBy: "chat-operator",
      resolvedAt: "2026-04-10T00:00:05.000Z",
      explanationStatus: "not_requested",
    } satisfies ApprovalRequest;
    const wakeApprovalWaitDurableRun = vi.fn(() => "approval-wait-1");
    const wakeDurableRun = vi.fn((runId: string) => ({ runId } as DurableRunRecord));
    const publishRealtime = vi.fn(
      (
        eventType: string,
        source: string,
        payload: Record<string, unknown>,
      ) => ({ eventType, source, payload } as RealtimeEvent),
    );
    const chatTrace = {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "waiting_for_approval",
      durable: {
        runId: "durable-turn-1",
      },
    } as ChatTurnTraceRecord;

    const result = applyApprovalResolutionWakeEffects(
      {
        storage: {
          chatInlineApprovals: {
            get: vi.fn(() => undefined),
          },
          chatTurnTraces: {
            get: vi.fn(() => chatTrace),
          },
        },
        approvalWaitRunService: {
          wakeApprovalWaitDurableRun,
        },
        publishRealtime,
        findProactiveDurableRunIdsForApproval: vi.fn(() => ["proactive-1", "proactive-2"]),
        wakeDurableRun,
      },
      approval,
      {
        decision: "approve",
        resolvedBy: "chat-operator",
      },
      {
        outcome: "executed",
        policyReason: "ok",
        auditEventId: "audit-1",
      } as ToolInvokeResult,
    );

    expect(wakeApprovalWaitDurableRun).toHaveBeenCalledWith(
      approval,
      expect.objectContaining({ decision: "approve", resolvedBy: "chat-operator" }),
      expect.objectContaining({ outcome: "executed" }),
    );
    expect(wakeDurableRun).toHaveBeenNthCalledWith(
      1,
      "proactive-1",
      expect.objectContaining({ eventKey: "approval.resolved", correlationId: "approval-1" }),
    );
    expect(wakeDurableRun).toHaveBeenNthCalledWith(
      2,
      "proactive-2",
      expect.objectContaining({ eventKey: "approval.resolved", correlationId: "approval-1" }),
    );
    expect(wakeDurableRun).toHaveBeenNthCalledWith(
      3,
      "durable-turn-1",
      expect.objectContaining({ eventKey: "approval.resolved", correlationId: "approval-1" }),
    );
    expect(result).toEqual({
      approvalWaitDurableRunId: "approval-wait-1",
      proactiveRunIds: ["proactive-1", "proactive-2"],
      chatTurnResume: {
        resumed: true,
        turnId: "turn-1",
        durableRunId: "durable-turn-1",
      },
    });
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("reports skipped wakes without throwing when linked runs are no longer waiting", () => {
    const approval = {
      approvalId: "approval-2",
      kind: "browser.navigate",
      riskLevel: "caution",
      status: "rejected" as const,
      payload: {},
      preview: {},
      createdAt: "2026-04-10T00:00:00.000Z",
      resolvedBy: "chat-operator",
      resolvedAt: "2026-04-10T00:00:05.000Z",
      explanationStatus: "not_requested",
    } satisfies ApprovalRequest;
    const wakeDurableRun = vi.fn((runId: string) => {
      if (runId === "proactive-stale" || runId === "durable-turn-stale") {
        throw new Error(`Durable run ${runId} is not waiting/paused`);
      }
      return { runId } as DurableRunRecord;
    });
    const publishRealtime = vi.fn(
      (
        eventType: string,
        source: string,
        payload: Record<string, unknown>,
      ) => ({ eventType, source, payload } as RealtimeEvent),
    );
    const inlineApproval = {
      approvalId: "approval-2",
      sessionId: "session-1",
      turnId: "turn-stale",
      status: "pending",
      createdAt: "2026-04-10T00:00:00.000Z",
    };
    const staleTrace = {
      turnId: "turn-stale",
      sessionId: "session-1",
      status: "waiting_for_approval",
      durable: {
        runId: "durable-turn-stale",
      },
    } as ChatTurnTraceRecord;

    const result = applyApprovalResolutionWakeEffects(
      {
        storage: {
          chatInlineApprovals: {
            get: vi.fn(() => inlineApproval),
          },
          chatTurnTraces: {
            get: vi.fn(() => staleTrace),
          },
        },
        approvalWaitRunService: {
          wakeApprovalWaitDurableRun: vi.fn(() => undefined),
        },
        publishRealtime,
        findProactiveDurableRunIdsForApproval: vi.fn(() => ["proactive-stale"]),
        wakeDurableRun,
      },
      approval,
      {
        decision: "reject",
        resolvedBy: "chat-operator",
      },
    );

    expect(result).toEqual({
      approvalWaitDurableRunId: undefined,
      proactiveRunIds: [],
      chatTurnResume: {
        resumed: false,
        turnId: "turn-stale",
        durableRunId: "durable-turn-stale",
      },
    });
    expect(publishRealtime).toHaveBeenCalledTimes(2);
  });
});
