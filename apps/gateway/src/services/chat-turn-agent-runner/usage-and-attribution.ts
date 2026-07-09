import type {
  ChatCompletionResponse,
  ChatStreamUsageRecord,
  ChatToolRunRecord,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";

type ToolSourceAttribution = NonNullable<ToolInvokeRequest["sourceAttribution"]>[number];

export function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

export function collectSourceAttributionFromToolRuns(
  toolRuns: ChatToolRunRecord[] | undefined,
): ToolInvokeRequest["sourceAttribution"] | undefined {
  const attributions: ToolSourceAttribution[] = [];
  for (const toolRun of toolRuns ?? []) {
    collectSourceAttributionFromToolResult(toolRun.result, attributions);
  }
  if (attributions.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  return attributions.filter((attribution) => {
    const key = [
      attribution.sourceType,
      attribution.sourceRef,
      attribution.trustLevel ?? "",
      attribution.backend ?? "",
      attribution.title ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectSourceAttributionFromToolResult(value: unknown, output: ToolSourceAttribution[]): void {
  const result = toPlainRecord(value);
  if (!result) {
    return;
  }
  pushSourceAttribution(result.attribution, output);
  for (const attribution of Array.isArray(result.sourceAttribution) ? result.sourceAttribution : []) {
    pushSourceAttribution(attribution, output);
  }
  const document = toPlainRecord(result.document);
  pushSourceAttribution(document?.attribution, output);
  for (const key of ["items", "chunks"] as const) {
    const items = Array.isArray(result[key]) ? result[key] : [];
    for (const item of items) {
      const record = toPlainRecord(item);
      pushSourceAttribution(record?.attribution, output);
    }
  }
}

function pushSourceAttribution(value: unknown, output: ToolSourceAttribution[]): void {
  const attribution = normalizeSourceAttribution(value);
  if (attribution) {
    output.push(attribution);
  }
}

function normalizeSourceAttribution(value: unknown): ToolSourceAttribution | undefined {
  const record = toPlainRecord(value);
  if (!record) {
    return undefined;
  }
  const sourceType = readContextSourceType(record.sourceType);
  const sourceRef =
    typeof record.sourceRef === "string" && record.sourceRef.trim() ? record.sourceRef.trim() : undefined;
  if (!sourceType || !sourceRef) {
    return undefined;
  }
  const trustLevel = readToolExecutionTrustLevel(record.trustLevel);
  return {
    sourceType,
    sourceRef,
    ...(typeof record.title === "string" && record.title.trim() ? { title: record.title.trim() } : {}),
    ...(record.backend === "native" || record.backend === "firecrawl" ? { backend: record.backend } : {}),
    ...(typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? { fetchedAt: record.fetchedAt.trim() } : {}),
    ...(trustLevel ? { trustLevel } : {}),
  };
}

function readContextSourceType(value: unknown): ToolSourceAttribution["sourceType"] | undefined {
  return value === "file" || value === "url" || value === "text" || value === "memory" || value === "mcp"
    ? value
    : undefined;
}

function readToolExecutionTrustLevel(value: unknown): ToolSourceAttribution["trustLevel"] | undefined {
  return value === "trusted_operator" ||
    value === "trusted_workspace" ||
    value === "mixed_untrusted" ||
    value === "untrusted_external"
    ? value
    : undefined;
}

export function parseUsageFromCompletion(completion: ChatCompletionResponse): ChatStreamUsageRecord | null {
  const usage = completion.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = readUsageNumber(usage.prompt_tokens) ?? readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.completion_tokens) ?? readUsageNumber(usage.output_tokens);
  const cachedInputTokens = readUsageNumber(usage.cached_prompt_tokens) ?? readUsageNumber(usage.cached_input_tokens);
  const costUsd = readUsageNumber(usage.cost_usd) ?? readUsageNumber(usage.total_cost_usd);
  const costSource = costUsd !== undefined ? readUsageCostSource(usage) : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    costUsd === undefined
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
    costSource,
  };
}

export function buildTraceUsageRecord(
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  },
  costSource?: ChatStreamUsageRecord["costSource"],
): ChatStreamUsageRecord {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    costUsd: totals.costUsd,
    ...(costSource ? { costSource } : {}),
  };
}

export function resolveUsageCostSource(
  sources: Set<NonNullable<ChatStreamUsageRecord["costSource"]>>,
): ChatStreamUsageRecord["costSource"] | undefined {
  if (sources.size === 0) {
    return undefined;
  }
  if (sources.size === 1) {
    return [...sources][0];
  }
  return "mixed";
}

function readUsageCostSource(usage: Record<string, unknown>): ChatStreamUsageRecord["costSource"] | undefined {
  const raw = typeof usage.cost_source === "string" ? usage.cost_source : usage.costSource;
  if (raw === "provider_reported" || raw === "estimated" || raw === "mixed" || raw === "unknown") {
    return raw;
  }
  if (raw === "provider-reported" || raw === "provider") {
    return "provider_reported";
  }
  if (raw === "estimate") {
    return "estimated";
  }
  if (usage.cost_estimated === true || usage.estimated === true) {
    return "estimated";
  }
  return undefined;
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
