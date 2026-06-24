/**
 * Runtime-decision trace recorders for chat turn preparation.
 *
 * Emits best-effort decision-trace records (chat_turn_prepared, memory_context)
 * describing how a turn was assembled. Extracted verbatim from
 * chat-turn-prep-service.ts to keep that module under the max-lines budget;
 * behavior is unchanged.
 */

import type { RuntimeDecisionTraceAppendInput } from "@goatcitadel/contracts";
import type { ChatTurnPrepHost, PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

export function recordPreparedTurnDecisions(
  host: ChatTurnPrepHost,
  prepared: PreparedAgentChatTurn,
  input: {
    projectId?: string;
    missingRequiredProjectBinding: boolean;
    guidanceFileCount: number;
    threadKnowledgeCitationCount: number;
  },
): void {
  if (!host.recordRuntimeDecision) {
    return;
  }
  const mode = prepared.normalized.mode ?? prepared.prefs.mode;
  const webMode = prepared.normalized.webMode ?? prepared.prefs.webMode;
  const memoryMode = prepared.normalized.memoryMode ?? prepared.prefs.memoryMode;
  safeRecordRuntimeDecision(host, {
    kind: "chat_turn_prepared",
    scope: {
      citadelId: prepared.citadelId,
      workspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
    },
    selected: `${mode} turn prepared`,
    rationale:
      "Gateway normalized operator preferences, branch lineage, model-router hints, guidance, and context before dispatch.",
    alternatives: [
      {
        label: "Code execution posture",
        outcome: input.missingRequiredProjectBinding ? "blocked" : "deferred",
        reasonNotChosen: input.missingRequiredProjectBinding
          ? "Code mode requires a bound project before execution-heavy work."
          : "Execution posture is governed later by tool, approval, and policy checks.",
        blockedBy: input.missingRequiredProjectBinding ? "missing_project_binding" : undefined,
      },
    ],
    signals: [
      { source: "operator_pref", key: "mode", value: mode, weight: "strong" },
      { source: "operator_pref", key: "web_mode", value: webMode, weight: "informational" },
      { source: "operator_pref", key: "memory_mode", value: memoryMode, weight: "informational" },
      { source: "operator_pref", key: "thinking_level", value: prepared.prefs.thinkingLevel, weight: "informational" },
      { source: "routing", key: "tool_autonomy", value: prepared.effectiveToolAutonomy, weight: "strong" },
      {
        source: "model_router",
        key: "route",
        value: prepared.modelRouterDecision.route,
        weight: prepared.modelRouterDecision.requiresTools ? "strong" : "informational",
      },
      {
        source: "model_router",
        key: "confidence_score",
        value: prepared.modelRouterDecision.confidenceScore,
        weight: "informational",
      },
      {
        source: "context",
        key: "project_bound",
        value: Boolean(input.projectId),
        weight: input.missingRequiredProjectBinding ? "blocking" : "informational",
      },
    ],
    evidenceRefs: [{ refType: "turn", refId: prepared.turnId }],
  });
  safeRecordRuntimeDecision(host, {
    kind: "memory_context",
    scope: {
      citadelId: prepared.citadelId,
      workspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
    },
    selected: memoryMode === "off" ? "Skip learned memory context" : "Compose scoped runtime context",
    rationale:
      memoryMode === "off"
        ? "Memory mode was off for this turn; runtime guidance and direct conversation context still applied."
        : "Gateway assembled retrieval posture, thread knowledge citations, and runtime guidance for prompt construction.",
    signals: [
      { source: "memory", key: "memory_mode", value: memoryMode, weight: memoryMode === "off" ? "strong" : "weak" },
      { source: "memory", key: "l0_used", value: prepared.retrievalTrace.l0Used, weight: "informational" },
      { source: "memory", key: "l1_used", value: prepared.retrievalTrace.l1Used, weight: "informational" },
      { source: "memory", key: "l2_used", value: prepared.retrievalTrace.l2Used, weight: "informational" },
      {
        source: "context",
        key: "thread_knowledge_citations",
        value: input.threadKnowledgeCitationCount,
        weight: "informational",
      },
      { source: "context", key: "guidance_file_count", value: input.guidanceFileCount, weight: "informational" },
    ],
    evidenceRefs: [{ refType: "turn", refId: prepared.turnId }],
  });
}

function safeRecordRuntimeDecision(host: ChatTurnPrepHost, input: RuntimeDecisionTraceAppendInput): void {
  try {
    host.recordRuntimeDecision?.(input);
  } catch {
    // Best-effort decision tracing is non-fatal and must not block turn preparation.
  }
}
