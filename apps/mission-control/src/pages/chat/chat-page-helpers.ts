import type { ChatQueueItemView } from "../../components/chat/ChatQueueBar";

import {
  inferProviderForModelId,
  providerAllowsForeignModelIds,
} from "@goatcitadel/contracts";

export type ChatOutboundAction = "send" | "edit" | "retry";
export type ChatStreamOperation = "resume" | "send" | "edit" | "retry";

export interface ProviderSelectionPlanInput {
  provider: {
    providerId: string;
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

export interface ProviderModelSelectionInput {
  provider: ProviderSelectionPlanInput["provider"];
  loadedModels: string[];
  selectedModel?: string;
}

export interface ProviderModelSelectionResult extends ProviderSelectionPlan {
  model?: string;
  modelNormalized?: boolean;
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

export function isLikelyLocalProviderUrl(baseUrl: string | undefined): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized);
}

export function resolveProviderModelSelection(input: ProviderModelSelectionInput): ProviderModelSelectionResult {
  const plan = resolveProviderSelectionPlan({
    provider: input.provider,
    loadedModels: input.loadedModels,
  });
  if (!input.provider || plan.blockedMessage || plan.missingModelMessage) {
    return plan;
  }

  const selectedModel = input.selectedModel?.trim();
  if (!selectedModel) {
    return {
      ...plan,
      model: plan.nextModel,
      modelNormalized: Boolean(plan.nextModel),
    };
  }

  const knownModels = dedupeStrings([
    ...input.loadedModels,
    ...input.provider.models,
    input.provider.defaultModel ?? "",
  ]);
  if (knownModels.includes(selectedModel)) {
    return {
      ...plan,
      model: selectedModel,
    };
  }

  const foreignProviderId = providerAllowsForeignModelIds(input.provider.providerId)
    ? undefined
    : inferProviderForModelId(selectedModel);
  if (!foreignProviderId || foreignProviderId === input.provider.providerId) {
    return {
      ...plan,
      model: selectedModel,
    };
  }

  return {
    ...plan,
    model: plan.nextModel,
    modelNormalized: selectedModel !== plan.nextModel,
  };
}
