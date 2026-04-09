import { createCorrelationId, recordClientDiagnostic } from "../../state/dev-diagnostics-store";
import type { RefreshSignal } from "../../state/refresh-bus";

type OutboundAction = "send" | "edit" | "retry";

type ChatOutboundPhase =
  | "start"
  | "session_ready"
  | "command_handoff"
  | "provider_selected"
  | "stream_seeded"
  | "stream_resume"
  | "thread_reconcile_applied"
  | "thread_reconcile_rejected"
  | "complete"
  | "aborted"
  | "failed";

type ChatApprovalPhase = "prompt_arrived" | "prompt_merged" | "resolve_started" | "resolved" | "dismissed";

type ChatRefreshPhase = "plan_resolved" | "plan_applied" | "plan_completed";

export interface ChatPendingApprovalDiagnostic {
  approvalId: string;
  toolName?: string;
  reason?: string;
}

export function createChatExecutionCorrelationId(): string {
  return createCorrelationId();
}

export function recordChatOutboundPhase(input: {
  phase: ChatOutboundPhase;
  action: OutboundAction;
  correlationId: string;
  sessionId?: string;
  turnId?: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  context?: Record<string, unknown>;
}): void {
  recordClientDiagnostic({
    level: input.level ?? "info",
    category: "chat",
    event: `outbound.${input.phase}`,
    message: input.message,
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    context: {
      action: input.action,
      phase: input.phase,
      ...(input.context ?? {}),
    },
  });
}

export function recordChatApprovalPhase(input: {
  phase: ChatApprovalPhase;
  sessionId?: string;
  turnId?: string;
  correlationId?: string;
  approval: ChatPendingApprovalDiagnostic;
  level?: "debug" | "info" | "warn" | "error";
  source?: "stream" | "thread" | "operator";
  context?: Record<string, unknown>;
}): void {
  recordClientDiagnostic({
    level: input.level ?? "info",
    category: "chat",
    event: `approval.${input.phase}`,
    message: `Approval ${input.phase.replace(/_/g, " ")}`,
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    context: {
      phase: input.phase,
      source: input.source,
      approvalId: input.approval.approvalId,
      toolName: input.approval.toolName,
      reason: input.approval.reason,
      ...(input.context ?? {}),
    },
  });
}

export function recordChatRefreshPhase(input: {
  phase: ChatRefreshPhase;
  sessionId?: string | null;
  signal: Pick<RefreshSignal, "eventType" | "reason" | "source">;
  plan?: {
    refreshSidebar: boolean;
    refreshSession: "none" | "light" | "full";
  };
  level?: "debug" | "info" | "warn" | "error";
  context?: Record<string, unknown>;
}): void {
  recordClientDiagnostic({
    level: input.level ?? "debug",
    category: "refresh",
    event: `refresh.${input.phase}`,
    message: `Chat refresh ${input.phase.replace(/_/g, " ")}`,
    sessionId: input.sessionId ?? undefined,
    context: {
      phase: input.phase,
      reason: input.signal.reason,
      eventType: input.signal.eventType,
      source: input.signal.source,
      refreshSidebar: input.plan?.refreshSidebar,
      refreshSession: input.plan?.refreshSession,
      ...(input.context ?? {}),
    },
  });
}
