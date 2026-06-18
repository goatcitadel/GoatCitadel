import type {
  CapabilityGapEventRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";

export interface ClassifiedCapabilityGap {
  causeClass: CapabilityGapEventRecord["causeClass"];
  recoveryOptions: CapabilityGapEventRecord["recoveryOptions"];
  configArea?: string;
  suggestedRepairClass?: string;
  confidence: number;
}

export function classifyCapabilityGapFromTrace(input: {
  trace: ChatTurnTraceRecord;
  suggestions?: ChatCapabilityUpgradeSuggestion[];
}): ClassifiedCapabilityGap | null {
  const suggestions = input.suggestions ?? input.trace.capabilityUpgradeSuggestions ?? [];
  const toolRun = [...input.trace.toolRuns]
    .reverse()
    .find((item) => item.status === "blocked" || item.status === "approval_required" || item.status === "failed");
  const failureClass = input.trace.failure?.failureClass;
  const normalizedEvidence = normalizeEvidence([
    toolRun?.error,
    input.trace.failure?.message,
    input.trace.routing.fallbackReason,
  ]);

  if (failureClass === "approval_required" || toolRun?.status === "approval_required") {
    return {
      causeClass: "tool_requires_approval_but_not_exposed",
      recoveryOptions: ["request_approval", "replay_failed_turn"],
      configArea: "config/tool-policy.json",
      suggestedRepairClass: "approval_path_exposure",
      confidence: 0.82,
    };
  }

  if (suggestions.some((item) => item.recommendedAction === "switch_tool_profile")) {
    return {
      causeClass: "tool_exists_but_not_in_profile",
      recoveryOptions: ["temporary_session_allow", "switch_tool_profile", "patch_config", "replay_failed_turn"],
      configArea: "config/tool-policy.json",
      suggestedRepairClass: "tool_profile_patch",
      confidence: 0.93,
    };
  }

  if (suggestions.some((item) => item.kind === "skill_import")) {
    return {
      causeClass: "skill_missing",
      recoveryOptions: ["install_skill", "replay_failed_turn"],
      configArea: "apps/gateway/src/services/skill-import-service.ts",
      suggestedRepairClass: "skill_install_candidate",
      confidence: 0.7,
    };
  }

  if (looksMissingRequiredToolEvidence(normalizedEvidence)) {
    return {
      causeClass: "missing_required_tool_evidence",
      recoveryOptions: ["patch_config", "replay_failed_turn"],
      configArea: "apps/gateway/src/services/chat-agent-orchestrator.ts",
      suggestedRepairClass: "tool_evidence_contract_patch",
      confidence: 0.78,
    };
  }

  if (looksProviderToolMismatch(normalizedEvidence)) {
    return {
      causeClass: "provider_tool_mismatch",
      recoveryOptions: ["reroute_provider", "replay_failed_turn"],
      configArea: "config/assistant.config.json",
      suggestedRepairClass: "provider_reroute",
      confidence: 0.74,
    };
  }

  if (
    failureClass === "network_interrupted" ||
    failureClass === "provider_timeout" ||
    looksRetryableNetworkFailure(normalizedEvidence)
  ) {
    return {
      causeClass: "retryable_network_failure",
      recoveryOptions: ["retry_once", "replay_failed_turn"],
      configArea: "apps/gateway/src/services/gateway-service.ts",
      suggestedRepairClass: "bounded_retry_path",
      confidence: 0.72,
    };
  }

  if (failureClass === "tool_blocked") {
    return {
      causeClass: "policy_denied_by_config",
      recoveryOptions: ["patch_config", "replay_failed_turn"],
      configArea: "config/tool-policy.json",
      suggestedRepairClass: "policy_config_patch",
      confidence: 0.7,
    };
  }

  return null;
}

function normalizeEvidence(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim()
    .toLowerCase();
}

function looksMissingRequiredToolEvidence(normalizedEvidence: string): boolean {
  return normalizedEvidence.includes("missing required tool evidence");
}

function looksProviderToolMismatch(normalizedEvidence: string): boolean {
  return (
    normalizedEvidence.includes("tool not supported") ||
    normalizedEvidence.includes("unsupported tool") ||
    normalizedEvidence.includes("does not support tools") ||
    normalizedEvidence.includes("model does not support tool") ||
    normalizedEvidence.includes("provider/tool mismatch")
  );
}

function looksRetryableNetworkFailure(normalizedEvidence: string): boolean {
  return (
    normalizedEvidence.includes("timed out") ||
    normalizedEvidence.includes("timeout") ||
    normalizedEvidence.includes("fetch failed") ||
    normalizedEvidence.includes("econnreset") ||
    normalizedEvidence.includes("enotfound") ||
    normalizedEvidence.includes("socket hang up") ||
    normalizedEvidence.includes("connection reset") ||
    normalizedEvidence.includes("network")
  );
}
