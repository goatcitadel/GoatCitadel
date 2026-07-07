import {
  getChatTurnRecoveryActionLabel,
  isChatTurnActiveStatus,
  type ChatCapabilityUpgradeSuggestion,
  type ChatThreadTurnRecord,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";

export type ChatTraceTone = "muted" | "warning" | "critical" | "success";

export function parseTimestamp(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const HUMANIZED_ENUM_LABELS: Record<string, string> = {
  error_fallback: "auto-failover",
  template_fallback: "template default",
  manual_fallback: "manual override",
  live: "live",
  waiting_for_approval: "waiting for approval",
  waiting_for_user_input: "waiting for your answer",
  waiting_for_tool: "using tools",
  in_progress: "in progress",
};

export function humanizeEnum(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  const mapped = HUMANIZED_ENUM_LABELS[trimmed.toLowerCase()];
  if (mapped) {
    return mapped;
  }
  if (/\s/.test(trimmed)) {
    return trimmed;
  }
  return toTitleCase(trimmed);
}

export function turnHasRepairedAssistantOutput(turn: ChatThreadTurnRecord): boolean {
  return Boolean(turn.trace.completion?.repaired);
}

/**
 * A turn is retryable when it produced assistant output, or when it failed
 * with a retryable failure (e.g. interrupted_by_restart) — those turns have no
 * assistant message at all, yet retry is exactly the recovery they need.
 */
export function canRetryTurn(turn: Pick<ChatThreadTurnRecord, "assistantMessage" | "trace">): boolean {
  return Boolean(turn.assistantMessage) || turn.trace.failure?.retryable === true;
}

export function getTraceTone(trace: ChatTurnTraceRecord): ChatTraceTone {
  if (trace.status === "failed") {
    return "critical";
  }
  if (trace.status === "completed" && !trace.failure) {
    return "success";
  }
  if (trace.status === "partial") {
    return "warning";
  }
  if (trace.status === "cancelled") {
    return "muted";
  }
  return "warning";
}

export function getTurnPendingLabel(trace: ChatTurnTraceRecord): string {
  switch (trace.status) {
    case "queued":
      return "Queued...";
    case "waiting_for_tool":
      return "Using tools...";
    case "waiting_for_approval":
      return "Waiting for approval.";
    case "waiting_for_user_input":
      return "Waiting for your answer.";
    case "cancelled":
      return "Turn cancelled.";
    case "failed":
      if (trace.failure?.failureClass === "interrupted_by_restart") {
        return "Interrupted by a gateway restart — retry to run it again.";
      }
      return trace.failure?.message ?? "Turn failed.";
    case "partial":
      return "Turn partially completed.";
    default:
      return "Working...";
  }
}

export function getAssistantPendingLabel(trace: ChatTurnTraceRecord, options: { isStreamingTurn: boolean }): string {
  if (options.isStreamingTurn) {
    return "Receiving response...";
  }
  if (
    isChatTurnActiveStatus(trace.status) ||
    trace.status === "cancelled" ||
    trace.status === "failed" ||
    trace.status === "partial"
  ) {
    return getTurnPendingLabel(trace);
  }
  return "No assistant output yet.";
}

export function formatRoutingTarget(providerId?: string, model?: string, apiStyle?: string): string | null {
  const parts = [providerId, model, apiStyle].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function summarizeTurnRouting(
  turn: ChatThreadTurnRecord,
  options: { effectiveVerb?: "used" | "effective" } = {},
): string[] {
  const requested = formatRoutingTarget(turn.trace.routing.primaryProviderId, turn.trace.routing.primaryModel);
  const effective =
    formatRoutingTarget(
      turn.trace.routing.effectiveProviderId,
      turn.trace.routing.effectiveModel,
      turn.trace.routing.effectiveApiStyle,
    ) ??
    turn.trace.model ??
    null;
  const effectiveVerb = options.effectiveVerb ?? "used";
  const parts = [effective ? `${effectiveVerb} ${effective}` : null];
  if (requested && requested !== effective) {
    parts.push(`requested ${requested}`);
  }
  if (turn.trace.routing.fallbackReason) {
    parts.push(`fallback: ${humanizeEnum(turn.trace.routing.fallbackReason)}`);
  } else if (turn.trace.routing.fallbackUsed) {
    parts.push("fallback used");
  }
  return parts.filter((value): value is string => Boolean(value));
}

export function renderSuggestionSummary(suggestions: ChatCapabilityUpgradeSuggestion[] | undefined): string | null {
  if (!suggestions || suggestions.length === 0) {
    return null;
  }
  return suggestions
    .slice(0, 2)
    .map((item) => item.title)
    .join(" · ");
}

export function getRecoveryStripLabel(turn: ChatThreadTurnRecord): string | null {
  const action = turn.trace.failure?.recommendedAction;
  return action ? getChatTurnRecoveryActionLabel(action) : null;
}

export interface ChatDelegationStepLike {
  status: string;
}

export function summarizeDelegationSteps<TStep extends ChatDelegationStepLike>(
  steps: readonly TStep[],
): {
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  skippedCount: number;
  runningCount: number;
  currentStep: TStep | undefined;
} {
  let completedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let skippedCount = 0;
  let runningCount = 0;
  let currentRunningStep: TStep | undefined;
  let latestSettledStep: TStep | undefined;

  for (const step of steps) {
    if (step.status === "completed") {
      completedCount += 1;
      latestSettledStep = step;
    } else if (step.status === "failed") {
      failedCount += 1;
      latestSettledStep = step;
    } else if (step.status === "pending") {
      pendingCount += 1;
    } else if (step.status === "skipped") {
      skippedCount += 1;
    } else if (step.status === "running") {
      runningCount += 1;
      currentRunningStep ??= step;
    }
  }

  return {
    completedCount,
    failedCount,
    pendingCount,
    skippedCount,
    runningCount,
    currentStep: currentRunningStep ?? latestSettledStep ?? steps[0],
  };
}
