import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { ChatDurableRunFinalizeDeps } from "./chat-durable-run-service.js";

export const SYSTEM_HEARTBEAT_ACTOR_ID = "system-heartbeat" as const;

export async function buildDurableCheckpointState(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatToolRuns" | "chatToolArtifacts" | "chatMessages">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  options: { systemHeartbeat?: boolean } = {},
): Promise<Record<string, unknown>> {
  const [toolRuns, artifactRows] = await Promise.all([
    deps.chatToolRuns.listByTurn(prepared.turnId),
    deps.chatToolArtifacts.listByTurn(prepared.turnId),
  ]);
  const artifacts = artifactRows.map((artifact) => ({
    artifactId: artifact.artifactId,
    toolRunId: artifact.toolRunId,
    toolName: artifact.toolName,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    storageRelPath: artifact.storageRelPath,
    snippet: artifact.snippet,
  }));
  const terminalOutput = await readCanonicalDurableChatTerminalOutput(deps, prepared, trace, options);
  return {
    objective: prepared.content,
    currentStep: trace.status,
    attemptedTools: toolRuns.map((run) => ({
      toolRunId: run.toolRunId,
      toolName: run.toolName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    artifactPointers: artifacts,
    blocker: trace.failure?.message,
    nextAction: trace.failure?.recommendedAction,
    ...(terminalOutput
      ? {
          assistantMessageId: terminalOutput.assistantMessageId,
          outputText: terminalOutput.outputText,
          outputSummary: terminalOutput.outputSummary,
        }
      : {}),
  };
}

export interface CanonicalDurableChatTerminalOutput {
  assistantMessageId: string;
  outputText: string;
  outputSummary: string;
}

export async function readCanonicalDurableChatTerminalOutput(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatMessages">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  options: { systemHeartbeat?: boolean } = {},
): Promise<CanonicalDurableChatTerminalOutput | undefined> {
  if (trace.status !== "completed" && trace.status !== "partial") {
    return undefined;
  }
  const messageId = prepared.assistantMessageId;
  if (!messageId) {
    return undefined;
  }
  if (trace.assistantMessageId !== undefined && trace.assistantMessageId !== messageId) {
    throw new Error(`Chat turn ${prepared.turnId} terminal trace points at a different assistant message.`);
  }
  const message = await deps.chatMessages?.get(messageId);
  const expectedActorType = options.systemHeartbeat ? "system" : "agent";
  const expectedActorId = options.systemHeartbeat ? SYSTEM_HEARTBEAT_ACTOR_ID : undefined;
  if (
    !message ||
    message.messageId !== messageId ||
    message.sessionId !== prepared.session.sessionId ||
    message.role !== "assistant" ||
    message.actorType !== expectedActorType ||
    (expectedActorId !== undefined && message.actorId !== expectedActorId)
  ) {
    if (message) {
      throw new Error(`Chat turn ${prepared.turnId} terminal assistant message has invalid canonical linkage.`);
    }
    return undefined;
  }
  const content = message.content;
  if (!content.trim()) {
    return undefined;
  }
  return {
    assistantMessageId: messageId,
    outputText: content,
    outputSummary: options.systemHeartbeat ? content : summarizeDurableChatAssistantOutput(content),
  };
}

export function summarizeDurableChatAssistantOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

export function mergeCanonicalDurableChatTerminalOutputMetadata(
  metadata: Record<string, unknown> | undefined,
  output: CanonicalDurableChatTerminalOutput | undefined,
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) };
  if (!output) {
    delete next.outputText;
    delete next.finalOutput;
    delete next.outputSummary;
    delete next.finalSummary;
    delete next.outputMessageId;
    delete next.outputTraceStatus;
    return Object.keys(next).length > 0 ? next : undefined;
  }
  delete next.outputMessageId;
  delete next.outputTraceStatus;
  return {
    ...next,
    outputText: output.outputText,
    finalOutput: output.outputText,
    outputSummary: output.outputSummary,
    finalSummary: output.outputSummary,
  };
}
