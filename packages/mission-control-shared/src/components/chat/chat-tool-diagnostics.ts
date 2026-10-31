import type { ChatToolRunRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { readOpenCodeRunSummary } from "@goatcitadel/contracts";

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
  const agent = readOpenCodeRunSummary(result.externalAgent);
  if (agent) {
    if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      return `OpenCode exited with code ${result.exitCode}. Inspect partial output before retrying.`;
    }
    if (agent.error) return agent.error;
    return `${agent.steps.length} reported steps · ${agent.files.length} reported files${agent.truncated ? " · partial output" : ""}`;
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return `Command exited with code ${result.exitCode}. Open details for output.`;
  }
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

/**
 * Governed design-instruction posture of an artifact result. Reads the compacted receipt
 * (`designQuality.runtimeInstructionsStatus`) or the full design report so the summary stays
 * truthful whether or not the tool output was virtualized.
 */
function describeDesignInstructionPosture(result: Record<string, unknown>): string | undefined {
  const compact = isRecord(result.designQuality) ? result.designQuality : undefined;
  const report = isRecord(result.designReport) ? result.designReport : undefined;
  const quality = isRecord(report?.designQuality) ? report.designQuality : undefined;
  const runtimeInstructions = isRecord(quality?.runtimeInstructions) ? quality.runtimeInstructions : undefined;
  const status = readString(compact?.status, quality?.status);
  const instructionStatus = readString(compact?.runtimeInstructionsStatus, runtimeInstructions?.status);
  if (!status || status === "skipped" || instructionStatus !== "not_injected") {
    return undefined;
  }
  return "Governed design instructions were not injected; renderer defaults were used.";
}

function joinSummaryParts(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join(" ") : undefined;
}

/**
 * A Chat Code Mode request whose code did not finish. The tool call still settles as executed, so the waiting turn
 * resumes with the outcome; the failure is in its result (`{ status: "failed", error }`).
 */
export function isFailedCodeModeRequest(run: Pick<ChatToolRunRecord, "toolName" | "result">): boolean {
  return run.toolName === "code_mode.request" && isRecord(run.result) && run.result.status === "failed";
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
  const failedRequest = isFailedCodeModeRequest(run);
  return {
    url: readString(result?.url),
    finalUrl: readString(result?.finalUrl, result?.url),
    httpStatus: readNumber(result?.status, result?.httpStatus),
    engineTier: readString(result?.engineTier),
    engineLabel: readString(result?.engineLabel),
    browserFailureClass,
    summary: failedRequest
      ? readString(result?.error)
      : result
        ? joinSummaryParts(summarizeResult(result), describeDesignInstructionPosture(result))
        : undefined,
    storedAsArtifact: result?.storedAsArtifact === true,
    outputVirtualized: result?.virtualized === true,
    artifactId: readString(result?.artifactId),
    artifactPath: readString(result?.artifactPath),
    artifactSummary: readString(result?.artifactSummary),
    originalByteLength: readNumber(result?.originalByteLength, result?.byteLength),
    fallbackAttemptCount: fallbackChain.length > 1 ? fallbackChain.length - 1 : 0,
    hasFailureSignal:
      run.status === "failed" ||
      run.status === "blocked" ||
      failedRequest ||
      Boolean(run.error) ||
      Boolean(browserFailureClass) ||
      (typeof result?.exitCode === "number" && result.exitCode !== 0) ||
      Boolean(readOpenCodeRunSummary(result?.externalAgent)?.error),
  };
}

export function getTraceFallbackAttemptCount(trace: ChatTurnTraceRecord): number {
  return trace.toolRuns.reduce((sum, run) => sum + getChatToolRunDiagnostics(run).fallbackAttemptCount, 0);
}
