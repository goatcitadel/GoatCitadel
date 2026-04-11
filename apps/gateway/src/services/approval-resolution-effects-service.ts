import type {
  ApprovalRequest,
  ApprovalResolveInput,
  DurableRunRecord,
  RealtimeEvent,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ApprovalWaitRunService } from "./approval-wait-run-service.js";

export interface ApprovalChatTurnResumeResult {
  resumed: boolean;
  turnId?: string;
  durableRunId?: string;
}

export interface ApprovalResolutionEffectsResult {
  approvalWaitDurableRunId?: string;
  proactiveRunIds: string[];
  chatTurnResume: ApprovalChatTurnResumeResult;
}

export interface ApprovalResolutionEffectsHost {
  readonly storage: {
    readonly chatInlineApprovals: {
      get(approvalId: string): { turnId?: string } | undefined;
    };
    readonly chatTurnTraces: {
      get(turnId: string): { durable?: { runId?: string } };
    };
  };
  readonly approvalWaitRunService: Pick<ApprovalWaitRunService, "wakeApprovalWaitDurableRun">;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;
  findProactiveDurableRunIdsForApproval(approvalId: string): string[];
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
  ): DurableRunRecord;
}

export function applyApprovalResolutionWakeEffects(
  host: ApprovalResolutionEffectsHost,
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
  executedAction?: ToolInvokeResult,
): ApprovalResolutionEffectsResult {
  const payload = {
    approvalId: approval.approvalId,
    status: approval.status,
    decision: input.decision,
    resolvedBy: input.resolvedBy,
    executedOutcome: executedAction?.outcome,
  };

  const approvalWaitDurableRunId = host.approvalWaitRunService.wakeApprovalWaitDurableRun(approval, input, executedAction);
  const proactiveRunIds = wakeProactiveRuns(host, approval, payload);
  const chatTurnResume = wakeLinkedChatTurn(host, approval, payload);

  return {
    approvalWaitDurableRunId,
    proactiveRunIds,
    chatTurnResume,
  };
}

function wakeProactiveRuns(
  host: ApprovalResolutionEffectsHost,
  approval: ApprovalRequest,
  payload: {
    approvalId: string;
    status: ApprovalRequest["status"];
    decision: ApprovalResolveInput["decision"];
    resolvedBy: string;
    executedOutcome?: ToolInvokeResult["outcome"];
  },
): string[] {
  const woken: string[] = [];
  for (const proactiveRunId of host.findProactiveDurableRunIdsForApproval(approval.approvalId)) {
    try {
      host.wakeDurableRun(proactiveRunId, {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
        payload,
      });
      woken.push(proactiveRunId);
    } catch (error) {
      const msg = String((error as Error).message ?? "");
      if (!msg.includes("not waiting/paused")) {
        throw error;
      }
      host.publishRealtime(
        "approval_proactive_wake_skipped",
        "approvals",
        {
          approvalId: approval.approvalId,
          runId: proactiveRunId,
          reason: "proactive_run_not_waiting",
          detail: msg,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            approvalId: approval.approvalId,
            runId: proactiveRunId,
          },
        },
      );
    }
  }
  return woken;
}

function wakeLinkedChatTurn(
  host: ApprovalResolutionEffectsHost,
  approval: ApprovalRequest,
  payload: {
    approvalId: string;
    status: ApprovalRequest["status"];
    decision: ApprovalResolveInput["decision"];
    resolvedBy: string;
    executedOutcome?: ToolInvokeResult["outcome"];
  },
): ApprovalChatTurnResumeResult {
  const turnId = resolveLinkedTurnId(host, approval);
  if (!turnId) {
    return { resumed: false };
  }

  let trace: { durable?: { runId?: string } } | undefined;
  try {
    trace = host.storage.chatTurnTraces.get(turnId);
  } catch {
    return { resumed: false, turnId };
  }

  const durableRunId = trace.durable?.runId;
  if (!durableRunId) {
    return { resumed: false, turnId };
  }

  try {
    host.wakeDurableRun(durableRunId, {
      eventKey: "approval.resolved",
      correlationId: approval.approvalId,
      payload,
    });
    return {
      resumed: true,
      turnId,
      durableRunId,
    };
  } catch (error) {
    const msg = String((error as Error).message ?? "");
    if (!msg.includes("not waiting/paused")) {
      throw error;
    }
    host.publishRealtime(
      "approval_chat_turn_wake_skipped",
      "approvals",
      {
        approvalId: approval.approvalId,
        turnId,
        runId: durableRunId,
        reason: "chat_turn_run_not_waiting",
        detail: msg,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: approval.approvalId,
          turnId,
          runId: durableRunId,
        },
      },
    );
    return {
      resumed: false,
      turnId,
      durableRunId,
    };
  }
}

function resolveLinkedTurnId(host: ApprovalResolutionEffectsHost, approval: ApprovalRequest): string | undefined {
  const linkageTurnId =
    typeof approval.linkage?.turnId === "string" && approval.linkage.turnId.trim()
      ? approval.linkage.turnId.trim()
      : undefined;
  if (linkageTurnId) {
    return linkageTurnId;
  }
  const payloadTurnId =
    typeof approval.payload?.turnId === "string" && approval.payload.turnId.trim()
      ? approval.payload.turnId.trim()
      : undefined;
  if (payloadTurnId) {
    return payloadTurnId;
  }
  return host.storage.chatInlineApprovals.get(approval.approvalId)?.turnId;
}
