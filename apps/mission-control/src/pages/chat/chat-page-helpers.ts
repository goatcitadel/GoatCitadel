import type { ChatQueueItemView } from "../../components/chat/ChatQueueBar";

export type ChatOutboundAction = "send" | "edit" | "retry";
export type ChatStreamOperation = "resume" | "send" | "edit" | "retry";

export interface ProviderSelectionPlanInput {
  provider: {
    label: string;
    disabled?: boolean;
    availabilityHint?: string;
    models: string[];
    defaultModel?: string;
  } | null | undefined;
  loadedModels: string[];
}

export interface ProviderSelectionPlan {
  blockedMessage?: string;
  nextModel?: string;
  missingModelMessage?: string;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function buildQueuedOutboundItemView(item: {
  id: string;
  action: ChatOutboundAction;
  content: string;
  createdAt: string;
  paused?: boolean;
  targetTurnId?: string;
}): ChatQueueItemView {
  return {
    id: item.id,
    action: item.action,
    label: item.content.trim().length > 0
      ? item.content.trim().slice(0, 96)
      : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
    createdAt: item.createdAt,
    paused: item.paused,
  };
}

export function resolveStreamTurnOperation(input: {
  action: ChatOutboundAction;
  resumeAttempts: number;
  targetTurnId?: string;
}): ChatStreamOperation {
  if (input.resumeAttempts > 0) {
    return "resume";
  }
  if (input.action === "retry" && input.targetTurnId) {
    return "retry";
  }
  if (input.action === "edit" && input.targetTurnId) {
    return "edit";
  }
  return "send";
}

export function resolveProviderSelectionPlan(input: ProviderSelectionPlanInput): ProviderSelectionPlan {
  if (!input.provider) {
    return {
      blockedMessage: undefined,
    };
  }
  if (input.provider.disabled) {
    return {
      blockedMessage: input.provider.availabilityHint ?? `${input.provider.label} is not configured yet.`,
    };
  }
  const nextModel = dedupeStrings([
    ...input.loadedModels,
    ...input.provider.models,
    input.provider.defaultModel ?? "",
  ])[0];
  if (!nextModel) {
    return {
      missingModelMessage: `No models are available for ${input.provider.label} yet. Check the provider configuration and retry.`,
    };
  }
  return {
    nextModel,
  };
}
