import type {
  LlmProviderAdviceRequest,
  LlmProviderAdviceResponse,
  LlmProviderRuntimeFit,
  LlmProviderSummary,
  LlmRuntimeEngineKind,
  LlmRuntimeMeasurementRecord,
} from "@goatcitadel/contracts";
import { estimateUsageCostUsd } from "./llm-pricing.js";

const SYNTHETIC_USAGE = {
  prompt_tokens: 100_000,
  completion_tokens: 10_000,
  cached_prompt_tokens: 0,
};

export function buildLlmProviderAdvice(
  input: LlmProviderAdviceRequest,
  providers: LlmProviderSummary[],
  runtime?: {
    latestMeasurement(providerId: string, model: string): LlmRuntimeMeasurementRecord | undefined;
    inferEngineKind(provider: LlmProviderSummary): LlmRuntimeEngineKind;
  },
): LlmProviderAdviceResponse {
  const preference = input.preference ?? "balanced";
  const requireConfiguredKey = input.requireConfiguredKey ?? false;
  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? 5, 20));
  const taskHint = input.taskHint?.trim().toLowerCase() ?? "";
  const candidates = providers
    .filter((provider) => !requireConfiguredKey || provider.hasApiKey)
    .map((provider) => {
      const configured = provider.hasApiKey;
      const estimatedCostUsd = estimateUsageCostUsd({
        providerId: provider.providerId,
        model: provider.defaultModel,
        usage: SYNTHETIC_USAGE,
      });
      const latestMeasurement = runtime?.latestMeasurement(provider.providerId, provider.defaultModel);
      const localRuntimeFit = runtime
        ? buildRuntimeFit(provider, runtime.inferEngineKind(provider), latestMeasurement)
        : undefined;
      return {
        providerId: provider.providerId,
        providerLabel: provider.label,
        model: provider.defaultModel,
        configured,
        estimatedCostUsd,
        costSource: estimatedCostUsd === undefined ? ("unknown" as const) : ("estimated" as const),
        fitScore: scoreProvider(provider, preference, taskHint, estimatedCostUsd, localRuntimeFit),
        riskNotes: buildRiskNotes(provider, estimatedCostUsd, localRuntimeFit),
        requiredKeys: configured ? [] : [provider.apiKeyRef ?? provider.providerId],
        measurementSource: localRuntimeFit?.measurementSource,
        hardwareFit: localRuntimeFit?.fit,
        localRuntimeFit,
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
      "Runtime fit uses source-labeled measurements when available; missing hardware data remains unavailable.",
    ],
  };
}

function scoreProvider(
  provider: LlmProviderSummary,
  preference: NonNullable<LlmProviderAdviceRequest["preference"]>,
  taskHint: string,
  estimatedCostUsd: number | undefined,
  runtimeFit: LlmProviderRuntimeFit | undefined,
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
  if (preference === "runtime_fit") {
    score +=
      runtimeFit?.fit === "strong" ? 0.22 : runtimeFit?.fit === "ok" ? 0.14 : runtimeFit?.fit === "weak" ? 0 : 0.04;
  }
  return Number(Math.min(1, score).toFixed(2));
}

function buildRiskNotes(
  provider: LlmProviderSummary,
  estimatedCostUsd: number | undefined,
  runtimeFit: LlmProviderRuntimeFit | undefined,
): string[] {
  const notes: string[] = [];
  if (!provider.hasApiKey && provider.authMode !== undefined) {
    notes.push("Required provider credential is not configured.");
  }
  if (estimatedCostUsd === undefined) {
    notes.push("No local pricing estimate is available for this provider/model.");
  }
  if (provider.apiStyle.includes("codex")) {
    notes.push("Codex-style provider behavior should stay on governed Code surfaces.");
  }
  if (runtimeFit?.measurementSource === "unavailable") {
    notes.push("No measured runtime telemetry is available for this provider/model.");
  }
  if (runtimeFit?.notes.length) {
    notes.push(...runtimeFit.notes);
  }
  return notes.length ? notes : ["No immediate advisory risk noted."];
}

function buildRuntimeFit(
  provider: LlmProviderSummary,
  engineKind: LlmRuntimeEngineKind,
  measurement: LlmRuntimeMeasurementRecord | undefined,
): LlmProviderRuntimeFit {
  const fit = classifyRuntimeFit(measurement);
  const notes = measurement
    ? [`Latest runtime measurement is ${measurement.source} and ${measurement.status}.`]
    : ["Runtime fit is advisory because no measurement has been captured yet."];
  if (engineKind === "remote_api") {
    notes.push("Remote API fit does not imply local hardware availability.");
  }
  if (!provider.baseUrl) {
    notes.push("Provider has no configured base URL for local engine inference.");
  }
  return {
    engineKind,
    fit,
    measurementSource: measurement?.source ?? "unavailable",
    latestMeasurementId: measurement?.measurementId,
    latencyMs: measurement?.metrics.latencyMs,
    outputTokensPerSecond: measurement?.metrics.outputTokensPerSecond,
    estimatedCostUsd: measurement?.metrics.estimatedCostUsd,
    notes,
  };
}

function classifyRuntimeFit(record: LlmRuntimeMeasurementRecord | undefined): LlmProviderRuntimeFit["fit"] {
  if (!record) return "unknown";
  if (record.status === "failed") return "weak";
  if (record.metrics.latencyMs !== undefined && record.metrics.latencyMs <= 5000) return "strong";
  if (record.status === "completed" || record.status === "partial") return "ok";
  return "unknown";
}
