import type { ChatToolRunRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function summarizeResult(result: Record<string, unknown>): string | undefined {
  const artifactSummary = readString(result.artifactSummary);
  if (artifactSummary) {
    return artifactSummary;
  }
  const artifactSnippet = readString(result.snippet);
  if (artifactSnippet) {
    return artifactSnippet;
  }
  if (Array.isArray(result.results)) {
    const count = result.results.length;
    return count === 0 ? "No results returned." : `${count} result${count === 1 ? "" : "s"} returned.`;
  }
  return readString(result.textSnippet, result.bodySnippet, result.contentText, result.message);
}

export function getChatToolRunDiagnostics(run: ChatToolRunRecord): {
  url?: string;
  finalUrl?: string;
  httpStatus?: number;
  engineTier?: string;
  engineLabel?: string;
  browserFailureClass?: string;
  summary?: string;
  storedAsArtifact: boolean;
  outputVirtualized: boolean;
  artifactId?: string;
  artifactPath?: string;
  artifactSummary?: string;
  originalByteLength?: number;
  fallbackAttemptCount: number;
  hasFailureSignal: boolean;
} {
  const result = isRecord(run.result) ? run.result : undefined;
  const fallbackChain = Array.isArray(result?.fallbackChain) ? result.fallbackChain : [];
  const browserFailureClass = readString(result?.browserFailureClass);
  return {
    url: readString(result?.url),
    finalUrl: readString(result?.finalUrl, result?.url),
    httpStatus: readNumber(result?.status, result?.httpStatus),
    engineTier: readString(result?.engineTier),
    engineLabel: readString(result?.engineLabel),
    browserFailureClass,
    summary: result ? summarizeResult(result) : undefined,
    storedAsArtifact: result?.storedAsArtifact === true,
    outputVirtualized: result?.virtualized === true,
    artifactId: readString(result?.artifactId),
    artifactPath: readString(result?.artifactPath),
    artifactSummary: readString(result?.artifactSummary),
    originalByteLength: readNumber(result?.originalByteLength, result?.byteLength),
    fallbackAttemptCount: fallbackChain.length > 1 ? fallbackChain.length - 1 : 0,
    hasFailureSignal: run.status === "failed"
      || run.status === "blocked"
      || Boolean(run.error)
      || Boolean(browserFailureClass),
  };
}

export function getTraceFallbackAttemptCount(trace: ChatTurnTraceRecord): number {
  return trace.toolRuns.reduce((sum, run) => sum + getChatToolRunDiagnostics(run).fallbackAttemptCount, 0);
}
