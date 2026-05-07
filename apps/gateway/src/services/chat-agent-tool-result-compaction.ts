const TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES = 12_000;
const TOOL_OUTPUT_INLINE_SUMMARY_CHARS = 1_400;
const TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS = 4_000;

export interface PersistableToolArtifactContent {
  readonly content: string;
  readonly contentType?: string;
  readonly snippet: string;
  readonly summary: string;
  readonly virtualized: boolean;
  readonly compactMode: "textual" | "structured";
}

export interface PersistedToolArtifactSummary {
  readonly artifactId: string;
  readonly storageRelPath: string;
  readonly byteLength: number;
  readonly contentType?: string;
  readonly snippet?: string;
  readonly summary: string;
  readonly virtualized: boolean;
  readonly compactMode: "textual" | "structured";
}

export function extractPersistableToolArtifactContent(
  toolName: string,
  result: Record<string, unknown>,
): PersistableToolArtifactContent | undefined {
  if (typeof result.body === "string" && result.body.length > 0) {
    if (Buffer.byteLength(result.body, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
      return undefined;
    }
    return {
      content: result.body,
      contentType: typeof result.contentType === "string" ? result.contentType : undefined,
      snippet:
        typeof result.bodySnippet === "string"
          ? result.bodySnippet.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS)
          : result.body.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  if (typeof result.text === "string" && result.text.length > 0) {
    if (Buffer.byteLength(result.text, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
      return undefined;
    }
    return {
      content: result.text,
      contentType: "text/plain; charset=utf-8",
      snippet: result.text.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
      summary: summarizeVirtualizedToolResult(toolName, result),
      virtualized: true,
      compactMode: "textual",
    };
  }
  const serialized = safeSerializeToolResult(result);
  if (!serialized || Buffer.byteLength(serialized, "utf8") <= TOOL_OUTPUT_VIRTUALIZATION_THRESHOLD_BYTES) {
    return undefined;
  }
  return {
    content: serialized,
    contentType: "application/json; charset=utf-8",
    snippet: serialized.slice(0, TOOL_OUTPUT_ARTIFACT_SNIPPET_CHARS),
    summary: summarizeVirtualizedToolResult(toolName, result),
    virtualized: true,
    compactMode: "structured",
  };
}

export function safeSerializeToolResult(result: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return undefined;
  }
}

export function summarizeVirtualizedToolResult(toolName: string, result: Record<string, unknown>): string {
  const candidates = [
    typeof result.message === "string" ? result.message : undefined,
    typeof result.bodySnippet === "string" ? result.bodySnippet : undefined,
    typeof result.textSnippet === "string" ? result.textSnippet : undefined,
    Array.isArray(result.results)
      ? `${result.results.length} result${result.results.length === 1 ? "" : "s"} returned.`
      : undefined,
    typeof result.status === "number" ? `HTTP ${result.status}` : undefined,
  ].filter((value): value is string => Boolean(value && value.trim()));
  if (candidates.length > 0) {
    return candidates.join(" ").slice(0, TOOL_OUTPUT_INLINE_SUMMARY_CHARS);
  }
  return `Stored ${toolName} output as an artifact to keep live context compact.`;
}

export function buildCompactToolResultMetadata(result: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  const scalarKeys = [
    "url",
    "finalUrl",
    "status",
    "httpStatus",
    "message",
    "engineTier",
    "engineLabel",
    "browserFailureClass",
    "title",
  ] as const;
  for (const key of scalarKeys) {
    const value = result[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      compacted[key] = value;
    }
  }
  if (Array.isArray(result.results)) {
    compacted.resultCount = result.results.length;
  }
  if (Array.isArray(result.fallbackChain) && result.fallbackChain.length > 0) {
    compacted.fallbackChain = result.fallbackChain;
  }
  return compacted;
}

export function compactToolResultForTurn(
  result: Record<string, unknown>,
  artifact: PersistedToolArtifactSummary,
): Record<string, unknown> {
  const resultText = typeof result.text === "string" ? result.text : undefined;
  const resultBodySnippet = typeof result.bodySnippet === "string" ? result.bodySnippet : undefined;
  const compacted: Record<string, unknown> = {
    ...(artifact.compactMode === "structured" ? buildCompactToolResultMetadata(result) : result),
    artifactId: artifact.artifactId,
    artifactPath: artifact.storageRelPath,
    byteLength: artifact.byteLength,
    originalByteLength: artifact.byteLength,
    contentType: artifact.contentType ?? result.contentType,
    snippet: artifact.snippet ?? resultBodySnippet ?? resultText?.slice(0, 4000),
    artifactSummary: artifact.summary,
    virtualized: artifact.virtualized,
    storedAsArtifact: true,
  };
  if ("body" in compacted) {
    delete (compacted as { body?: unknown }).body;
  }
  if (resultText && resultText.length > 4000) {
    compacted.text = resultText.slice(0, 4000);
  }
  if (artifact.compactMode === "structured" && "text" in compacted) {
    delete (compacted as { text?: unknown }).text;
  }
  if (!("bodySnippet" in compacted) && typeof compacted.snippet === "string") {
    compacted.bodySnippet = compacted.snippet;
  }
  return compacted;
}
