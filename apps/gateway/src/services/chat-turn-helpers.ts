import {
  GoatError,
  type ChatCitationRecord,
  type ChatMode,
  type ChatTurnFailureClass,
  type ChatTurnFailureRecord,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { OrchestrationStepExecutionResult } from "../orchestration/types.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";

export const DEFAULT_DELEGATION_ROLES = ["product", "architect", "coder", "qa", "ops"];

export class ChatTurnCancelledError extends GoatError {
  readonly code = "TURN_CANCELLED" as const;
  readonly httpStatus = 499;
  public constructor(
    public readonly turnId: string,
    message = "Chat turn cancelled.",
  ) {
    super(message, { turnId });
  }
}

export function isChatTurnCancelledError(error: unknown): boolean {
  if (error instanceof ChatTurnCancelledError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes("cancel") || message.includes("chat turn cancelled");
}

export async function patchChatTurnTraceIfStatus(
  repository: Pick<Storage["chatTurnTraces"], "get" | "patch" | "patchIfStatus">,
  turnId: string,
  expectedStatuses: readonly ChatTurnTraceRecord["status"][],
  input: Parameters<Storage["chatTurnTraces"]["patch"]>[1],
): Promise<ChatTurnTraceRecord> {
  const current = await repository.get(turnId);
  if (!expectedStatuses.includes(current.status)) {
    throwChatTurnCompletionOwnershipError(turnId, current.status);
  }
  const patched = repository.patchIfStatus
    ? await repository.patchIfStatus(turnId, expectedStatuses, input)
    : await repository.patch(turnId, input);
  if (patched) {
    return patched;
  }
  throwChatTurnCompletionOwnershipError(turnId, (await repository.get(turnId)).status);
}

export async function tryPatchChatTurnTraceIfStatus(
  repository: Pick<Storage["chatTurnTraces"], "get" | "patch" | "patchIfStatus">,
  turnId: string,
  expectedStatuses: readonly ChatTurnTraceRecord["status"][],
  input: Parameters<Storage["chatTurnTraces"]["patch"]>[1],
): Promise<{ trace: ChatTurnTraceRecord; patched: boolean }> {
  const current = await repository.get(turnId);
  if (!expectedStatuses.includes(current.status)) {
    return { trace: current, patched: false };
  }
  const patched = repository.patchIfStatus
    ? await repository.patchIfStatus(turnId, expectedStatuses, input)
    : await repository.patch(turnId, input);
  return patched ? { trace: patched, patched: true } : { trace: await repository.get(turnId), patched: false };
}

function throwChatTurnCompletionOwnershipError(turnId: string, status: ChatTurnTraceRecord["status"]): never {
  if (status === "cancelled") {
    throw new ChatTurnCancelledError(turnId);
  }
  throw new Error(`Chat turn ${turnId} completion lost lifecycle ownership to ${status}.`);
}

export function splitIntoChunks(input: string, maxChunkLength: number): string[] {
  if (!input) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = input;
  const chunkSize = Math.max(1, maxChunkLength);
  while (remaining.length > chunkSize) {
    chunks.push(remaining.slice(0, chunkSize));
    remaining = remaining.slice(chunkSize);
  }
  chunks.push(remaining);
  return chunks;
}

export function buildEmptyAssistantTurnFallbackText(): string {
  return [
    "Summary",
    "- I completed the turn, but the final assistant text was empty after tool/model synthesis.",
    "",
    "Constraints",
    "- This usually means tool/model outputs were incomplete or could not be stitched into a final response.",
    "",
    "What I did instead",
    "- Preserved trace/tool evidence for this turn.",
    "",
    "What I need from you next",
    "- Retry once, or provide tighter constraints (explicit query/url/path) for deterministic tool execution.",
  ].join("\n");
}

export function inferDegradedAssistantTurnFailure(content: string): ChatTurnFailureRecord | undefined {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("i ran out of time before i could finish") ||
    normalized.startsWith("i couldn't finish that cleanly because") ||
    normalized.includes("recover useful content from") ||
    normalized.includes("strongest leads so far")
  ) {
    return {
      failureClass: "unknown",
      message: "Assistant response degraded into a fallback-style partial answer after tool execution.",
      retryable: true,
      recommendedAction: "retry_narrower",
    };
  }
  return undefined;
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

export function toTitleCase(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function detectDelegationRoles(objective: string): string[] {
  const normalized = objective.toLowerCase();
  const roleHints: Array<{ role: string; patterns: RegExp[] }> = [
    { role: "product", patterns: [/\bproduct\b/, /\bprd\b/, /\brequirements?\b/] },
    { role: "architect", patterns: [/\barchitect\b/, /\bdesign\b/, /\barchitecture\b/] },
    { role: "coder", patterns: [/\bcoder\b/, /\bdeveloper\b/, /\bimplementation\b/, /\bbuild\b/] },
    { role: "qa", patterns: [/\bqa\b/, /\btest\b/, /\bvalidation\b/] },
    { role: "ops", patterns: [/\bops\b/, /\bdeploy\b/, /\brollout\b/, /\brelease\b/] },
    { role: "researcher", patterns: [/\bresearch\b/, /\banalyze\b/, /\bsources?\b/] },
  ];
  const roles = roleHints
    .filter((hint) => hint.patterns.some((pattern) => pattern.test(normalized)))
    .map((hint) => hint.role);
  if (roles.length > 0) {
    return roles;
  }
  if (/->|route this through|multi-agent|agents work together|handoff/.test(normalized)) {
    return [...DEFAULT_DELEGATION_ROLES.slice(0, 3)];
  }
  return [];
}

export function renderExecutionPlanAsMarkdown(input: {
  mode: ChatMode;
  objective: string;
  summary: string;
  steps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"];
}): string {
  const modeLabel = input.mode === "cowork" ? "Cowork plan" : input.mode === "code" ? "Code plan" : "Chat plan";
  const stepLines = input.steps.map((step) => {
    const parts = [
      `${step.index + 1}. ${step.objective}`,
      step.successCriteria ? `Success: ${step.successCriteria}` : undefined,
      step.expectedOutput ? `Output: ${step.expectedOutput}` : undefined,
      step.suggestedTools?.length ? `Suggested tools: ${step.suggestedTools.join(", ")}` : undefined,
      step.dependsOnStepIds?.length ? `Depends on: ${step.dependsOnStepIds.join(", ")}` : undefined,
      step.delegatedRole ? `Delegated role: ${step.delegatedRole}` : undefined,
    ].filter(Boolean);
    return parts.join("\n   ");
  });
  return [
    `## ${modeLabel}`,
    "",
    `Objective: ${input.objective}`,
    "",
    input.summary,
    "",
    "Planned steps:",
    ...stepLines,
  ].join("\n");
}

export function truncateSummaryLine(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function mergeExecutionPlanStepStatuses(
  planSteps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"],
  results: OrchestrationStepExecutionResult[],
): PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"] {
  return planSteps.map((planStep, index) => {
    const result =
      results.find((item) => item.stepId === planStep.stepId) ?? results.find((item) => item.index === index);
    if (!result) {
      return planStep;
    }
    return {
      ...planStep,
      status: result.status === "skipped" ? "cancelled" : result.status,
      summary: result.summary,
      error: result.error,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      childRunId: result.childRunId,
      durableRunId: result.durableRunId,
      childSessionId: result.childSessionId,
      childTurnId: result.childTurnId,
    };
  });
}

export function buildDelegationFailureGuidance(error: string, role: string): string {
  const normalized = error.toLowerCase();
  if (/\btool(?:-|\s*)run budget\b|\btool budget\b|tool_run_budget_exceeded/.test(normalized)) {
    return `${toTitleCase(role)} hit the tool-run budget. Continue from the strongest gathered leads and ask only for the missing fields.`;
  }
  if (/\bnot yet allowlisted\b|\bnot allowlisted\b|\ballowlist(?:ed)? host\b/.test(normalized)) {
    return `${toTitleCase(role)} reached a host that is not allowlisted. Request allowlist approval for that host or continue from search-result evidence with unverified fields called out.`;
  }
  if (/\bauth|login|token|credential|permission\b/.test(normalized)) {
    return `${toTitleCase(role)} hit an auth or permission barrier. Reconnect the required account or switch to another source.`;
  }
  if (/\babort|aborted|cancelled|canceled\b/.test(normalized)) {
    return `${toTitleCase(role)} was cancelled before it completed. Retry only if that work is still needed.`;
  }
  if (/\btimeout|timed out|deadline\b/.test(normalized)) {
    return `${toTitleCase(role)} ran out of time. Retry with a narrower brief or fewer sources.`;
  }
  if (/\bblocked|deny|denied|approval|policy|jail\b/.test(normalized)) {
    return `${toTitleCase(role)} hit a restricted action. Use a safer fallback path or request approval explicitly.`;
  }
  if (/\bnot found|404|missing\b/.test(normalized)) {
    return `${toTitleCase(role)} could not find the expected input. Retry with a more explicit file, path, or source reference.`;
  }
  return `Retry the ${role} delegate with a narrower brief or a different tool/source strategy.`;
}

const INCOMPLETE_DELEGATED_FAILURE_CLASSES = new Set<ChatTurnFailureClass>([
  "tool_run_budget_exceeded",
  "turn_budget_exceeded",
  "budget_exceeded",
  "tool_blocked",
  "tool_failed",
  "tool_loop_guard",
  "global_circuit_breaker",
  "provider_timeout",
  "network_interrupted",
]);

export function isIncompleteDelegatedTraceFailure(failure?: ChatTurnFailureRecord): boolean {
  return failure ? INCOMPLETE_DELEGATED_FAILURE_CLASSES.has(failure.failureClass) : false;
}

export function buildIncompleteDelegatedTraceFailureGuidance(
  failure: ChatTurnFailureRecord | undefined,
  output: string,
  role: string,
): string {
  if (failure?.failureClass === "tool_run_budget_exceeded") {
    return `${toTitleCase(role)} hit the tool-run budget. Continue from gathered leads, avoid repeating completed lookups, and focus only on missing fields.`;
  }
  if (failure?.failureClass === "tool_blocked") {
    return `${toTitleCase(role)} hit a blocked source. Continue from alternate sources, or request approval/allowlisting before retrying the same host.`;
  }
  return buildDelegationFailureGuidance(failure?.message ?? output, role);
}

export function dedupeChatCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const deduped: ChatCitationRecord[] = [];
  const seen = new Map<string, number>();
  for (const citation of citations) {
    const key = citation.knowledge
      ? [
          "knowledge",
          citation.knowledge.attachmentId,
          citation.knowledge.chunkId ?? citation.knowledge.sectionLabel ?? citation.knowledge.sourceRef,
          citation.knowledge.retrievalMode,
        ]
          .join(":")
          .toLowerCase()
      : citation.url.trim().toLowerCase();
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, deduped.length);
      deduped.push(citation);
      continue;
    }
    const existing = deduped[existingIndex];
    if (!existing) {
      seen.set(key, deduped.length);
      deduped.push(citation);
      continue;
    }
    deduped[existingIndex] = {
      ...existing,
      citationId: existing.citationId,
      url: existing.url,
      title: existing.title ?? citation.title,
      snippet: existing.snippet ?? citation.snippet,
      sourceType: existing.sourceType ?? citation.sourceType,
      knowledge: existing.knowledge ?? citation.knowledge,
      provenance: existing.provenance ?? citation.provenance,
    };
  }
  return deduped;
}

export function readDurableRecoveryInterruption(signal: AbortSignal | undefined, error: unknown): Error | undefined {
  const candidate = signal?.aborted ? signal.reason : error;
  if (!(candidate instanceof Error)) {
    return undefined;
  }
  return candidate.name === "DurableWorkerInterruptionError" || candidate.name === "DurableRunPausedError"
    ? candidate
    : undefined;
}

export function readDurableCancellation(signal: AbortSignal | undefined, _error: unknown): Error | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const candidate = signal.reason;
  return candidate instanceof Error && candidate.name === "DurableRunCancelledError" ? candidate : undefined;
}
