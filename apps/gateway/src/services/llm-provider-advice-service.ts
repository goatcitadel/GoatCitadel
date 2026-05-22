import type { LlmProviderAdviceRequest, LlmProviderAdviceResponse, LlmProviderSummary } from "@goatcitadel/contracts";
import { estimateUsageCostUsd } from "./llm-pricing.js";

const SYNTHETIC_USAGE = {
  prompt_tokens: 100_000,
  completion_tokens: 10_000,
};

export function buildLlmProviderAdvice(
  input: LlmProviderAdviceRequest,
  providers: LlmProviderSummary[],
): LlmProviderAdviceResponse {
  const preference = input.preference ?? "balanced";
  const requireConfiguredKey = input.requireConfiguredKey ?? false;
  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? 5, 20));
  const taskHint = input.taskHint?.trim().toLowerCase() ?? "";
  const candidates = providers
    .filter((provider) => !requireConfiguredKey || provider.hasApiKey || provider.authMode !== "api-key")
    .map((provider) => {
      const configured =
        provider.hasApiKey || provider.authMode === "codex-oauth" || provider.authMode === "claude-code-oauth";
      const estimatedCostUsd = estimateUsageCostUsd({
        providerId: provider.providerId,
        model: provider.defaultModel,
        usage: SYNTHETIC_USAGE,
      });
      return {
        providerId: provider.providerId,
        providerLabel: provider.label,
        model: provider.defaultModel,
        configured,
        estimatedCostUsd,
        costSource: estimatedCostUsd === undefined ? ("unknown" as const) : ("estimated" as const),
        fitScore: scoreProvider(provider, preference, taskHint, estimatedCostUsd),
        riskNotes: buildRiskNotes(provider, estimatedCostUsd),
        requiredKeys: configured ? [] : [provider.apiKeyRef ?? provider.providerId],
      };
    })
    .sort((left, right) => {
      if (preference === "low_cost") {
        const leftCost = left.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
        const rightCost = right.estimatedCostUsd ?? Number.POSITIVE_INFINITY;
        if (leftCost !== rightCost) {
          return leftCost - rightCost;
        }
      }
      return right.fitScore - left.fitScore;
    })
    .slice(0, maxCandidates);
  return {
    generatedAt: new Date().toISOString(),
    preference,
    candidates,
    advisoryOnly: true,
    mutationPerformed: false,
    warnings: [
      "Provider advice is advisory only; no provider settings or keys were changed.",
      "Costs are estimates for a synthetic 100k input / 10k output token task when pricing is known.",
    ],
  };
}

function scoreProvider(
  provider: LlmProviderSummary,
  preference: NonNullable<LlmProviderAdviceRequest["preference"]>,
  taskHint: string,
  estimatedCostUsd: number | undefined,
): number {
  let score = provider.hasApiKey ? 0.45 : 0.25;
  if (provider.capabilities?.toolCalling) score += 0.1;
  if (provider.capabilities?.reasoning) score += 0.08;
  if (provider.capabilities?.vision && /\b(image|vision|screenshot|ui|design)\b/.test(taskHint)) score += 0.12;
  if (provider.capabilities?.webSearch && /\b(latest|current|news|research|search)\b/.test(taskHint)) score += 0.12;
  if (preference === "low_cost") {
    score += estimatedCostUsd === undefined ? 0 : Math.max(0, 0.25 - estimatedCostUsd / 20);
  }
  if (preference === "capability_fit") {
    score += 0.12;
  }
  return Number(Math.min(1, score).toFixed(2));
}

function buildRiskNotes(provider: LlmProviderSummary, estimatedCostUsd: number | undefined): string[] {
  const notes: string[] = [];
  if (!provider.hasApiKey && provider.authMode === "api-key") {
    notes.push("Required API key is not configured.");
  }
  if (estimatedCostUsd === undefined) {
    notes.push("No local pricing estimate is available for this provider/model.");
  }
  if (provider.apiStyle.includes("codex")) {
    notes.push("Codex-style provider behavior should stay on governed Code surfaces.");
  }
  return notes.length ? notes : ["No immediate advisory risk noted."];
}
