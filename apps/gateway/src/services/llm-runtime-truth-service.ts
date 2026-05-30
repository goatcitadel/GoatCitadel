import { createHash, randomUUID } from "node:crypto";
import type {
  ChatCompletionResponse,
  LlmEvalProofCandidate,
  LlmEvalProofCandidateResult,
  LlmEvalProofRunRecord,
  LlmEvalProofRunRequest,
  LlmEvalProofRunResponse,
  LlmEvalProofRunsResponse,
  LlmLocalEngineCatalogResponse,
  LlmLocalEngineRecord,
  LlmProviderSummary,
  LlmRuntimeEngineKind,
  LlmRuntimeMeasurementMetrics,
  LlmRuntimeMeasurementRecord,
  LlmRuntimeMeasurementsQuery,
  LlmRuntimeMeasurementsResponse,
} from "@goatcitadel/contracts";
import { estimateUsageCostUsd } from "./llm-pricing.js";

interface LlmRuntimeTruthServiceOptions {
  storage: {
    llmRuntimeMeasurements: {
      insert(record: LlmRuntimeMeasurementRecord): LlmRuntimeMeasurementRecord;
      list(query?: LlmRuntimeMeasurementsQuery): LlmRuntimeMeasurementRecord[];
      latest(providerId: string, model: string): LlmRuntimeMeasurementRecord | undefined;
    };
    llmEvalProofRuns: {
      insert(record: LlmEvalProofRunRecord): LlmEvalProofRunRecord;
      list(limit?: number): LlmEvalProofRunRecord[];
    };
  };
  listProviders: () => LlmProviderSummary[];
}

interface BuildRuntimeMeasurementInput {
  providerId: string;
  model: string;
  provider?: Pick<LlmProviderSummary, "providerId" | "baseUrl">;
  response?: ChatCompletionResponse;
  usage?: Record<string, unknown>;
  stream: boolean;
  startedAt: number;
  completedAt: number;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  path: LlmRuntimeMeasurementRecord["provenance"]["path"];
  status: LlmRuntimeMeasurementRecord["status"];
  error?: string;
}

const LOCAL_ENGINE_LABELS: Array<{ engineKind: LlmRuntimeEngineKind; label: string }> = [
  { engineKind: "ollama", label: "Ollama" },
  { engineKind: "lmstudio", label: "LM Studio" },
  { engineKind: "llama_cpp", label: "llama.cpp" },
  { engineKind: "vllm", label: "vLLM" },
  { engineKind: "sglang", label: "SGLang" },
  { engineKind: "mlx", label: "MLX" },
  { engineKind: "lemonade", label: "Lemonade" },
  { engineKind: "apple_foundation_models", label: "Apple Foundation Models" },
  { engineKind: "litellm", label: "LiteLLM" },
  { engineKind: "npu_sidecar", label: "NPU sidecar" },
  { engineKind: "openai_compatible", label: "Local OpenAI-compatible endpoint" },
];

export class LlmRuntimeTruthService {
  private readonly storage: LlmRuntimeTruthServiceOptions["storage"];
  private readonly listProviders: LlmRuntimeTruthServiceOptions["listProviders"];

  public constructor(options: LlmRuntimeTruthServiceOptions) {
    this.storage = options.storage;
    this.listProviders = options.listProviders;
  }

  public recordMeasurement(record: LlmRuntimeMeasurementRecord): LlmRuntimeMeasurementRecord {
    return this.storage.llmRuntimeMeasurements.insert(record);
  }

  public listMeasurements(query: LlmRuntimeMeasurementsQuery = {}): LlmRuntimeMeasurementsResponse {
    return {
      generatedAt: new Date().toISOString(),
      items: this.storage.llmRuntimeMeasurements.list(query),
      warnings: ["Runtime telemetry is source-labeled; unavailable hardware metrics are not fabricated."],
    };
  }

  public latestMeasurement(providerId: string, model: string): LlmRuntimeMeasurementRecord | undefined {
    return this.storage.llmRuntimeMeasurements.latest(providerId, model);
  }

  public listLocalEngines(): LlmLocalEngineCatalogResponse {
    const providers = this.listProviders();
    const items = LOCAL_ENGINE_LABELS.map(({ engineKind, label }) => {
      const matchingProviders = providers.filter((provider) => inferRuntimeEngineKind(provider) === engineKind);
      const latestMeasurement = newestMeasurement(
        matchingProviders
          .map((provider) => this.storage.llmRuntimeMeasurements.latest(provider.providerId, provider.defaultModel))
          .filter(isDefined),
      );
      return buildLocalEngineRecord({
        engineKind,
        label,
        providers: matchingProviders,
        latestMeasurement,
      });
    });
    return {
      generatedAt: new Date().toISOString(),
      items,
      warnings: [
        "Local engine fit is advisory unless a configured provider has live runtime measurements.",
        "GoatCitadel does not invoke unsupported local runtimes just because they appear in this catalog.",
      ],
    };
  }

  public runEvalProof(input: LlmEvalProofRunRequest): LlmEvalProofRunResponse {
    const createdAt = new Date().toISOString();
    const candidates = normalizeEvalCandidates(input.candidates, this.listProviders());
    const warnings = [
      "Eval proof uses existing runtime measurements and optional operator quality scores; it does not call providers.",
      "Missing latency, cost, or hardware readings remain unavailable rather than inferred.",
    ];
    if (candidates.length === 0) {
      warnings.push("No configured provider candidates were available for this proof run.");
    }

    const preliminary = candidates.map((candidate) => this.buildEvalCandidateResult(candidate));
    const results = markPareto(preliminary);
    const run: LlmEvalProofRunRecord = {
      runId: randomUUID(),
      promptHash: createHash("sha256").update(input.prompt).digest("hex"),
      sessionId: input.sessionId?.trim() || undefined,
      taskId: input.taskId?.trim() || undefined,
      status: warnings.length > 0 ? "completed_with_warnings" : "completed",
      createdAt,
      candidates,
      results,
      warnings,
    };
    this.storage.llmEvalProofRuns.insert(run);
    return {
      generatedAt: createdAt,
      run,
    };
  }

  public listEvalProofRuns(limit = 20): LlmEvalProofRunsResponse {
    return {
      generatedAt: new Date().toISOString(),
      items: this.storage.llmEvalProofRuns.list(limit),
    };
  }

  private buildEvalCandidateResult(candidate: LlmEvalProofCandidate): LlmEvalProofCandidateResult {
    const latestMeasurement = this.storage.llmRuntimeMeasurements.latest(candidate.providerId, candidate.model);
    const notes: string[] = [];
    if (!latestMeasurement) {
      notes.push("No runtime measurement is available for this provider/model.");
    }
    if (candidate.qualityScore === undefined) {
      notes.push("No operator quality score was supplied.");
    }
    return {
      ...candidate,
      measurementSource: latestMeasurement?.source ?? "unavailable",
      latestMeasurement,
      qualityScoreSource: candidate.qualityScore === undefined ? "unavailable" : "operator",
      latencyMs: latestMeasurement?.metrics.latencyMs,
      estimatedCostUsd: latestMeasurement?.metrics.estimatedCostUsd,
      energyJoules: latestMeasurement?.metrics.energyJoules,
      paretoOptimal: false,
      notes,
    };
  }
}

export function buildLlmRuntimeMeasurementRecord(input: BuildRuntimeMeasurementInput): LlmRuntimeMeasurementRecord {
  const usage = input.usage ?? input.response?.usage;
  const latencyMs = Math.max(0, input.completedAt - input.startedAt);
  const metrics = buildRuntimeMetrics({
    providerId: input.providerId,
    model: input.model,
    usage,
    latencyMs,
  });
  return {
    measurementId: randomUUID(),
    providerId: input.providerId,
    model: input.model,
    engineKind: inferRuntimeEngineKind(input.provider ?? { providerId: input.providerId }),
    source: input.status === "failed" ? "unavailable" : "live",
    status: input.status,
    stream: input.stream,
    sessionId: input.sessionId,
    taskId: input.taskId,
    runId: input.runId,
    collectedAt: new Date(input.completedAt).toISOString(),
    metrics,
    provenance: {
      collector: "gateway",
      path: input.path,
      notes: buildMeasurementNotes(metrics),
    },
    error: input.error,
  };
}

export function extractUsageFromStreamChunks(
  chunks: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const usage = chunks[index]?.usage;
    if (isRecord(usage)) {
      return usage;
    }
  }
  return undefined;
}

export function inferRuntimeEngineKind(
  provider: Pick<LlmProviderSummary, "providerId"> & Partial<Pick<LlmProviderSummary, "baseUrl">>,
): LlmRuntimeEngineKind {
  const providerId = provider.providerId.trim().toLowerCase();
  const baseUrl = provider.baseUrl?.trim().toLowerCase() ?? "";
  if (providerId.includes("ollama") || baseUrl.includes("11434")) return "ollama";
  if (providerId.includes("llama") || baseUrl.includes("llama.cpp")) return "llama_cpp";
  if (providerId.includes("lmstudio") || providerId.includes("lm-studio") || baseUrl.includes("1234")) {
    return "lmstudio";
  }
  if (providerId.includes("vllm")) return "vllm";
  if (providerId.includes("sglang")) return "sglang";
  if (providerId.includes("mlx")) return "mlx";
  if (providerId.includes("lemonade")) return "lemonade";
  if (providerId.includes("apple-foundation") || providerId.includes("apple_foundation")) {
    return "apple_foundation_models";
  }
  if (providerId.includes("litellm")) return "litellm";
  if (providerId.includes("npu") || providerId.includes("genie")) return "npu_sidecar";
  if (isLocalBaseUrl(baseUrl)) return "openai_compatible";
  return baseUrl ? "remote_api" : "unknown";
}

function buildRuntimeMetrics(input: {
  providerId: string;
  model: string;
  usage: Record<string, unknown> | undefined;
  latencyMs: number;
}): LlmRuntimeMeasurementMetrics {
  const promptTokens = readNumber(input.usage?.prompt_tokens) ?? readNumber(input.usage?.input_tokens);
  const completionTokens = readNumber(input.usage?.completion_tokens) ?? readNumber(input.usage?.output_tokens);
  const totalTokens =
    readNumber(input.usage?.total_tokens) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);
  const outputTokensPerSecond =
    completionTokens !== undefined && input.latencyMs > 0
      ? Number((completionTokens / (input.latencyMs / 1000)).toFixed(3))
      : undefined;
  return removeUndefined({
    latencyMs: input.latencyMs,
    promptTokens,
    completionTokens,
    totalTokens,
    outputTokensPerSecond,
    estimatedCostUsd: estimateUsageCostUsd({
      providerId: input.providerId,
      model: input.model,
      usage: input.usage,
    }),
  });
}

function buildMeasurementNotes(metrics: LlmRuntimeMeasurementMetrics): string[] {
  const notes = ["Latency is measured at the gateway boundary."];
  if (metrics.promptTokens === undefined && metrics.completionTokens === undefined) {
    notes.push("Provider did not return token usage for this call.");
  }
  if (metrics.powerWatts === undefined && metrics.energyJoules === undefined) {
    notes.push("Power, energy, and accelerator utilization were unavailable.");
  }
  return notes;
}

function buildLocalEngineRecord(input: {
  engineKind: LlmRuntimeEngineKind;
  label: string;
  providers: LlmProviderSummary[];
  latestMeasurement?: LlmRuntimeMeasurementRecord;
}): LlmLocalEngineRecord {
  const configured = input.providers.length > 0;
  const fit = classifyMeasurementFit(input.latestMeasurement);
  return {
    engineKind: input.engineKind,
    label: input.label,
    configured,
    invocation: configured ? configuredInvocation(input.engineKind) : "advisory_only",
    providerIds: input.providers.map((provider) => provider.providerId),
    measurementSource: input.latestMeasurement?.source ?? "unavailable",
    latestMeasurement: input.latestMeasurement,
    fit,
    notes: configured
      ? buildConfiguredEngineNotes(input.latestMeasurement)
      : ["Engine is known to GoatCitadel but no provider is currently configured for it."],
  };
}

function buildConfiguredEngineNotes(latestMeasurement: LlmRuntimeMeasurementRecord | undefined): string[] {
  if (!latestMeasurement) {
    return ["Provider is configured, but no runtime measurement has been captured yet."];
  }
  return [`Latest measurement is ${latestMeasurement.source} and ${latestMeasurement.status}.`];
}

function configuredInvocation(engineKind: LlmRuntimeEngineKind): LlmLocalEngineRecord["invocation"] {
  if (engineKind === "llama_cpp" || engineKind === "npu_sidecar" || engineKind === "apple_foundation_models") {
    return "native";
  }
  return "openai_compatible";
}

function normalizeEvalCandidates(
  candidates: LlmEvalProofCandidate[] | undefined,
  providers: LlmProviderSummary[],
): LlmEvalProofCandidate[] {
  const source: LlmEvalProofCandidate[] = candidates?.length
    ? candidates
    : providers.map((provider) => ({
        providerId: provider.providerId,
        model: provider.defaultModel,
      }));
  const seen = new Set<string>();
  return source
    .map((candidate) => ({
      providerId: candidate.providerId.trim(),
      model: candidate.model.trim(),
      qualityScore: normalizeQualityScore(candidate.qualityScore),
    }))
    .filter((candidate) => candidate.providerId && candidate.model)
    .filter((candidate) => {
      const key = `${candidate.providerId}\u0000${candidate.model}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function normalizeQualityScore(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function markPareto(results: LlmEvalProofCandidateResult[]): LlmEvalProofCandidateResult[] {
  return results.map((candidate, index) => ({
    ...candidate,
    paretoOptimal: !results.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)),
  }));
}

function dominates(left: LlmEvalProofCandidateResult, right: LlmEvalProofCandidateResult): boolean {
  const leftQuality = left.qualityScore ?? 0;
  const rightQuality = right.qualityScore ?? 0;
  const leftLatency = minimizeMetric(left.latencyMs);
  const rightLatency = minimizeMetric(right.latencyMs);
  const leftCost = minimizeMetric(left.estimatedCostUsd);
  const rightCost = minimizeMetric(right.estimatedCostUsd);
  const leftEnergy = minimizeMetric(left.energyJoules);
  const rightEnergy = minimizeMetric(right.energyJoules);
  const atLeastAsGood =
    leftQuality >= rightQuality && leftLatency <= rightLatency && leftCost <= rightCost && leftEnergy <= rightEnergy;
  const strictlyBetter =
    leftQuality > rightQuality || leftLatency < rightLatency || leftCost < rightCost || leftEnergy < rightEnergy;
  return atLeastAsGood && strictlyBetter;
}

function classifyMeasurementFit(record: LlmRuntimeMeasurementRecord | undefined): LlmLocalEngineRecord["fit"] {
  if (!record) return "unknown";
  if (record.status === "failed") return "weak";
  const latencyMs = record.metrics.latencyMs;
  if (latencyMs !== undefined && latencyMs <= 5000) return "strong";
  if (record.status === "completed" || record.status === "partial") return "ok";
  return "unknown";
}

function newestMeasurement(records: LlmRuntimeMeasurementRecord[]): LlmRuntimeMeasurementRecord | undefined {
  return records.sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0];
}

function minimizeMetric(value: number | undefined): number {
  return value === undefined ? Number.POSITIVE_INFINITY : value;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}

function isLocalBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local");
  } catch {
    return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
