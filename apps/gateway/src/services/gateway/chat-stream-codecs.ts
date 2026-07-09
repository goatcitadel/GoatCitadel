import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCitationRecord,
  ChatStreamChunk,
  ChatStreamUsageRecord,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnRepairRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { DurableChatTurnExecutionPayload } from "../chat-turn-types.js";

export function chatStreamChunkToRecord(chunk: ChatStreamChunk): Record<string, unknown> {
  return { ...chunk };
}

export function toChatStreamChunk(value: unknown): ChatStreamChunk | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.sessionId !== "string") {
    return undefined;
  }
  const common = {
    type: value.type,
    sessionId: value.sessionId,
    eventId: typeof value.eventId === "string" ? value.eventId : "",
    sequence: typeof value.sequence === "number" && Number.isFinite(value.sequence) ? value.sequence : 0,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
  switch (value.type) {
    case "message_start":
      if (
        typeof value.turnId !== "string" ||
        typeof value.messageId !== "string" ||
        !isChatTurnBranchKind(value.branchKind)
      ) {
        return undefined;
      }
      return {
        ...common,
        type: "message_start",
        turnId: value.turnId,
        messageId: value.messageId,
        branchKind: value.branchKind,
        ...(typeof value.parentTurnId === "string" ? { parentTurnId: value.parentTurnId } : {}),
        ...(typeof value.sourceTurnId === "string" ? { sourceTurnId: value.sourceTurnId } : {}),
      };
    case "delta":
      return typeof value.turnId === "string" && typeof value.delta === "string"
        ? {
            ...common,
            type: "delta",
            turnId: value.turnId,
            delta: value.delta,
            ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
          }
        : undefined;
    case "usage":
      return typeof value.turnId === "string" && isChatStreamUsageRecord(value.usage)
        ? {
            ...common,
            type: "usage",
            turnId: value.turnId,
            usage: value.usage,
            ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
          }
        : undefined;
    case "message_done":
      return typeof value.turnId === "string" &&
        typeof value.messageId === "string" &&
        typeof value.content === "string"
        ? {
            ...common,
            type: "message_done",
            turnId: value.turnId,
            messageId: value.messageId,
            content: value.content,
            ...(typeof value.repaired === "boolean" ? { repaired: value.repaired } : {}),
            ...(isChatTurnRepairRecord(value.repair) ? { repair: value.repair } : {}),
            ...(isChatTurnDegradedRecord(value.degraded)
              ? { degraded: value.degraded as { reason: string; recoveredByModel: boolean } }
              : {}),
          }
        : undefined;
    case "tool_start":
    case "tool_result":
      return typeof value.turnId === "string" && isChatToolRunRecord(value.toolRun)
        ? {
            ...common,
            type: value.type,
            turnId: value.turnId,
            toolRun: value.toolRun,
          }
        : undefined;
    case "approval_required":
      return typeof value.turnId === "string" &&
        isRecord(value.approval) &&
        typeof value.approval.approvalId === "string"
        ? {
            ...common,
            type: "approval_required",
            turnId: value.turnId,
            approval: {
              approvalId: value.approval.approvalId,
              ...(typeof value.approval.toolName === "string" ? { toolName: value.approval.toolName } : {}),
              ...(typeof value.approval.reason === "string" ? { reason: value.approval.reason } : {}),
              ...(typeof value.approval.expiresAt === "string" ? { expiresAt: value.approval.expiresAt } : {}),
            },
          }
        : undefined;
    case "trace_update":
      return typeof value.turnId === "string" && isChatTurnTraceRecord(value.trace)
        ? {
            ...common,
            type: "trace_update",
            turnId: value.turnId,
            trace: value.trace,
          }
        : undefined;
    case "citation":
      return typeof value.turnId === "string" && isChatCitationRecord(value.citation)
        ? {
            ...common,
            type: "citation",
            turnId: value.turnId,
            citation: value.citation,
          }
        : undefined;
    case "capability_upgrade_suggestion":
      return typeof value.turnId === "string" && Array.isArray(value.capabilityUpgradeSuggestions)
        ? {
            ...common,
            type: "capability_upgrade_suggestion",
            turnId: value.turnId,
            capabilityUpgradeSuggestions: value.capabilityUpgradeSuggestions as ChatCapabilityUpgradeSuggestion[],
          }
        : undefined;
    case "error":
      return typeof value.error === "string"
        ? {
            ...common,
            type: "error",
            error: value.error,
            ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
          }
        : undefined;
    case "done":
      return typeof value.turnId === "string" && typeof value.messageId === "string"
        ? {
            ...common,
            type: "done",
            turnId: value.turnId,
            messageId: value.messageId,
          }
        : undefined;
    default:
      return undefined;
  }
}

export function durableChatTurnPayloadToRecord(payload: DurableChatTurnExecutionPayload): Record<string, unknown> {
  return { ...payload };
}

function isChatTurnBranchKind(value: unknown): value is ChatTurnBranchKind {
  return value === "append" || value === "retry" || value === "edit";
}

function isChatStreamUsageRecord(value: unknown): value is ChatStreamUsageRecord {
  return (
    isRecord(value) &&
    (value.inputTokens === undefined || typeof value.inputTokens === "number") &&
    (value.outputTokens === undefined || typeof value.outputTokens === "number") &&
    (value.cachedInputTokens === undefined || typeof value.cachedInputTokens === "number") &&
    (value.costUsd === undefined || typeof value.costUsd === "number")
  );
}

function isChatToolRunRecord(value: unknown): value is ChatToolRunRecord {
  return (
    isRecord(value) &&
    typeof value.toolRunId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.toolName === "string" &&
    (value.status === "started" ||
      value.status === "executed" ||
      value.status === "blocked" ||
      value.status === "approval_required" ||
      value.status === "failed") &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.approvalId === undefined || typeof value.approvalId === "string") &&
    (value.args === undefined || isRecord(value.args)) &&
    (value.result === undefined || isRecord(value.result)) &&
    (value.reused === undefined || typeof value.reused === "boolean") &&
    (value.reusedFromToolRunId === undefined || typeof value.reusedFromToolRunId === "string") &&
    (value.reuseReason === undefined || typeof value.reuseReason === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.failureGuidance === undefined || typeof value.failureGuidance === "string")
  );
}

function isChatTurnRepairRecord(value: unknown): value is ChatTurnRepairRecord {
  return (
    isRecord(value) &&
    typeof value.applied === "boolean" &&
    (value.kind === undefined || typeof value.kind === "string") &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.preRepairContent === undefined || typeof value.preRepairContent === "string") &&
    (value.postRepairContent === undefined || typeof value.postRepairContent === "string")
  );
}

function isChatTurnDegradedRecord(value: unknown): boolean {
  return isRecord(value) && typeof value.reason === "string" && typeof value.recoveredByModel === "boolean";
}

function isChatCitationRecord(value: unknown): value is ChatCitationRecord {
  return (
    isRecord(value) &&
    typeof value.citationId === "string" &&
    typeof value.url === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.snippet === undefined || typeof value.snippet === "string") &&
    (value.knowledge === undefined ||
      (isRecord(value.knowledge) &&
        typeof value.knowledge.attachmentId === "string" &&
        typeof value.knowledge.sourceRef === "string" &&
        typeof value.knowledge.title === "string" &&
        (value.knowledge.sectionLabel === undefined || typeof value.knowledge.sectionLabel === "string") &&
        (value.knowledge.chunkId === undefined || typeof value.knowledge.chunkId === "string") &&
        (value.knowledge.excerpt === undefined || typeof value.knowledge.excerpt === "string") &&
        (value.knowledge.retrievalMode === "full_text" || value.knowledge.retrievalMode === "retrieval"))) &&
    (value.provenance === undefined || isMemoryCitationProvenanceRecord(value.provenance)) &&
    (value.sourceType === undefined ||
      value.sourceType === "web" ||
      value.sourceType === "file" ||
      value.sourceType === "tool" ||
      value.sourceType === "memory")
  );
}

function isMemoryCitationProvenanceRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.relationScope === "self" || value.relationScope === "peer" || value.relationScope === "project") &&
    (value.freshness === "fresh" ||
      value.freshness === "recent" ||
      value.freshness === "stale" ||
      value.freshness === "unknown") &&
    typeof value.selectionReason === "string" &&
    (value.retrievalStrategy === undefined ||
      value.retrievalStrategy === "lexical_recency" ||
      value.retrievalStrategy === "semantic_hints" ||
      value.retrievalStrategy === "semantic_vector") &&
    (value.matchSignals === undefined || isMemoryRetrievalMatchSignalsRecord(value.matchSignals)) &&
    (value.sourceTimestamp === undefined || typeof value.sourceTimestamp === "string")
  );
}

function isMemoryRetrievalMatchSignalsRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.lexicalScore === "number" &&
    Number.isFinite(value.lexicalScore) &&
    typeof value.semanticHintScore === "number" &&
    Number.isFinite(value.semanticHintScore) &&
    (value.semanticVectorScore === undefined ||
      (typeof value.semanticVectorScore === "number" && Number.isFinite(value.semanticVectorScore))) &&
    typeof value.recencyScore === "number" &&
    Number.isFinite(value.recencyScore) &&
    typeof value.diversityScore === "number" &&
    Number.isFinite(value.diversityScore) &&
    typeof value.totalScore === "number" &&
    Number.isFinite(value.totalScore)
  );
}

function isChatTurnTraceRecord(value: unknown): value is ChatTurnTraceRecord {
  return (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.userMessageId === "string" &&
    (value.branchKind === "append" || value.branchKind === "retry" || value.branchKind === "edit") &&
    typeof value.status === "string" &&
    typeof value.mode === "string" &&
    typeof value.webMode === "string" &&
    typeof value.memoryMode === "string" &&
    typeof value.thinkingLevel === "string" &&
    typeof value.startedAt === "string" &&
    Array.isArray(value.toolRuns) &&
    value.toolRuns.every(isChatToolRunRecord) &&
    Array.isArray(value.citations) &&
    value.citations.every(isChatCitationRecord) &&
    isRecord(value.routing)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
