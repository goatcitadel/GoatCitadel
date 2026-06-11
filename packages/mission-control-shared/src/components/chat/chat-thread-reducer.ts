import type {
  ChatMessageRecord,
  ChatSessionPrefsRecord,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";

export interface PendingStreamTurnSeed {
  userMessage: ChatMessageRecord;
  parentTurnId?: string;
  branchKind: "append" | "retry" | "edit";
  sourceTurnId?: string;
  mode: "send" | "edit" | "retry";
}

export function isThreadMutatingStreamChunk(chunk: ChatStreamChunk): boolean {
  switch (chunk.type) {
    case "message_start":
    case "delta":
    case "message_done":
    case "tool_start":
    case "tool_result":
    case "user_input_required":
    case "trace_update":
    case "capability_upgrade_suggestion":
    case "citation":
      return true;
    default:
      return false;
  }
}

export function updateThreadFromStreamChunk(
  current: ChatThreadResponse | null,
  chunk: ChatStreamChunk,
  seed: PendingStreamTurnSeed | null,
  sessionId: string,
  prefs: ChatSessionPrefsRecord | null,
): ChatThreadResponse | null {
  if (chunk.sessionId !== sessionId) {
    return current;
  }

  if (chunk.type === "message_start") {
    if (!seed) {
      return current;
    }
    const startedAt = new Date().toISOString();
    const optimisticTurn: ChatThreadTurnRecord = {
      turnId: chunk.turnId,
      parentTurnId: chunk.parentTurnId,
      branchKind: chunk.branchKind,
      sourceTurnId: chunk.sourceTurnId,
      userMessage: seed.userMessage,
      assistantMessage: {
        messageId: chunk.messageId,
        sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "",
        timestamp: startedAt,
      },
      trace: {
        turnId: chunk.turnId,
        sessionId,
        userMessageId: seed.userMessage.messageId,
        parentTurnId: chunk.parentTurnId,
        branchKind: chunk.branchKind,
        sourceTurnId: chunk.sourceTurnId,
        assistantMessageId: chunk.messageId,
        status: "running",
        mode: prefs?.mode ?? "chat",
        model: prefs?.model,
        webMode: prefs?.webMode ?? "auto",
        memoryMode: prefs?.memoryMode ?? "auto",
        thinkingLevel: prefs?.thinkingLevel ?? "standard",
        speedMode: prefs?.speedMode ?? "standard",
        subagentPolicy: prefs?.subagentPolicy ?? "ask_when_useful",
        effectiveToolAutonomy: prefs?.planningMode === "advisory" ? "manual" : prefs?.toolAutonomy,
        startedAt,
        toolRuns: [],
        citations: [],
        routing: {
          primaryProviderId: prefs?.providerId,
          primaryModel: prefs?.model,
          effectiveProviderId: prefs?.providerId,
          effectiveModel: prefs?.model,
        },
      },
      toolRuns: [],
      citations: [],
      branch: {
        siblingTurnIds: [chunk.turnId],
        activeSiblingIndex: 0,
        siblingCount: 1,
        isSelectedPath: true,
        newestLeafTurnId: chunk.turnId,
      },
    };
    const baseTurns = (() => {
      if (!current || !chunk.parentTurnId) {
        return current?.turns ?? [];
      }
      const parentIndex = current.turns.findIndex((turn) => turn.turnId === chunk.parentTurnId);
      if (parentIndex < 0) {
        return current.turns;
      }
      return current.turns.slice(0, parentIndex + 1);
    })();
    return {
      sessionId,
      activeLeafTurnId: chunk.turnId,
      selectedTurnId: chunk.turnId,
      turns: [...baseTurns, optimisticTurn],
    };
  }

  if (!current || !("turnId" in chunk) || !chunk.turnId) {
    return current;
  }

  const turnIndex = current.turns.findIndex((turn) => turn.turnId === chunk.turnId);
  if (turnIndex < 0) {
    return current;
  }
  const currentTurn = current.turns[turnIndex]!;
  const nextTurn = updateTurnFromStreamChunk(currentTurn, chunk, sessionId);

  if (nextTurn === currentTurn) {
    return current;
  }
  const turns = current.turns.slice();
  turns[turnIndex] = nextTurn;

  // message_start owns moving selection and the active leaf to a new turn. In-place
  // turn updates must not re-point them: a late chunk for an older turn would
  // otherwise drag the active leaf (and the next send's parent turn) back to it.
  return {
    ...current,
    turns,
  };
}

function updateTurnFromStreamChunk(
  turn: ChatThreadTurnRecord,
  chunk: Exclude<ChatStreamChunk, { type: "message_start" }>,
  sessionId: string,
): ChatThreadTurnRecord {
  switch (chunk.type) {
    case "delta": {
      const nextContent = `${turn.assistantMessage?.content ?? ""}${chunk.delta}`;
      if (turn.assistantMessage && turn.assistantMessage.content === nextContent) {
        return turn;
      }
      return {
        ...turn,
        assistantMessage: turn.assistantMessage
          ? {
              ...turn.assistantMessage,
              messageId: chunk.messageId ?? turn.assistantMessage.messageId,
              content: nextContent,
            }
          : {
              messageId: chunk.messageId ?? `assistant-${turn.turnId}`,
              sessionId,
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: chunk.delta,
              timestamp: new Date().toISOString(),
            },
      };
    }
    case "message_done": {
      const sameAssistant =
        turn.assistantMessage &&
        turn.assistantMessage.messageId === chunk.messageId &&
        turn.assistantMessage.content === chunk.content;
      const nextTraceCompletion = chunk.repaired
        ? {
            ...turn.trace.completion,
            repaired: true,
            status: turn.trace.completion?.status ?? "complete",
          }
        : turn.trace.completion;
      const sameTraceCompletion =
        nextTraceCompletion === turn.trace.completion ||
        (nextTraceCompletion?.repaired === turn.trace.completion?.repaired &&
          nextTraceCompletion?.status === turn.trace.completion?.status &&
          nextTraceCompletion?.finishReason === turn.trace.completion?.finishReason);
      if (sameAssistant && sameTraceCompletion) {
        return turn;
      }
      return {
        ...turn,
        assistantMessage: turn.assistantMessage
          ? {
              ...turn.assistantMessage,
              messageId: chunk.messageId,
              content: chunk.content,
            }
          : {
              messageId: chunk.messageId,
              sessionId,
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: chunk.content,
              timestamp: new Date().toISOString(),
            },
        trace: {
          ...turn.trace,
          completion: nextTraceCompletion,
        },
      };
    }
    case "tool_start":
    case "tool_result": {
      const toolRuns = appendOrReplaceToolRun(turn.toolRuns, chunk.toolRun);
      return {
        ...turn,
        toolRuns,
        trace: {
          ...turn.trace,
          toolRuns,
        },
      };
    }
    case "citation": {
      const citations = appendOrReplaceCitation(turn.citations, chunk.citation);
      return {
        ...turn,
        citations,
        trace: {
          ...turn.trace,
          citations,
        },
      };
    }
    case "capability_upgrade_suggestion":
      return {
        ...turn,
        trace: {
          ...turn.trace,
          capabilityUpgradeSuggestions: chunk.capabilityUpgradeSuggestions,
        },
      };
    case "user_input_required":
      return {
        ...turn,
        trace: {
          ...turn.trace,
          status: "waiting_for_user_input",
          pendingUserInput: chunk.prompt,
        },
      };
    case "trace_update":
      return applyTraceUpdate(turn, chunk.trace);
    default:
      return turn;
  }
}

function applyTraceUpdate(turn: ChatThreadTurnRecord, trace: ChatThreadTurnRecord["trace"]): ChatThreadTurnRecord {
  const mergedTrace: ChatThreadTurnRecord["trace"] = {
    ...turn.trace,
    ...trace,
    assistantMessageId: trace.assistantMessageId ?? turn.trace.assistantMessageId,
    capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions ?? turn.trace.capabilityUpgradeSuggestions,
    toolRuns: trace.toolRuns ?? turn.trace.toolRuns,
    citations: dedupeCitations(trace.citations ?? turn.trace.citations),
    routing: trace.routing ?? turn.trace.routing,
  };
  const nextAssistantMessage = (() => {
    if (!turn.assistantMessage) {
      return turn.assistantMessage;
    }
    const nextMessageId = mergedTrace.assistantMessageId ?? turn.assistantMessage.messageId;
    if (nextMessageId === turn.assistantMessage.messageId) {
      return turn.assistantMessage;
    }
    return { ...turn.assistantMessage, messageId: nextMessageId };
  })();
  if (nextAssistantMessage === turn.assistantMessage && isShallowEqualRecord(mergedTrace, turn.trace)) {
    return turn;
  }
  return {
    ...turn,
    trace: mergedTrace,
    toolRuns: mergedTrace.toolRuns,
    citations: mergedTrace.citations,
    assistantMessage: nextAssistantMessage,
  };
}

function isShallowEqualRecord(next: object, prev: object): boolean {
  const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
  for (const key of keys) {
    if (!Object.is((next as Record<string, unknown>)[key], (prev as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

function appendOrReplaceToolRun(
  current: ChatThreadTurnRecord["toolRuns"],
  toolRun: ChatThreadTurnRecord["toolRuns"][number],
): ChatThreadTurnRecord["toolRuns"] {
  return [...current.filter((item) => item.toolRunId !== toolRun.toolRunId), toolRun];
}

function appendOrReplaceCitation(
  current: ChatThreadTurnRecord["citations"],
  citation: ChatThreadTurnRecord["citations"][number],
): ChatThreadTurnRecord["citations"] {
  return dedupeCitations([...current, citation]);
}

function dedupeCitations(citations: ChatThreadTurnRecord["citations"]): ChatThreadTurnRecord["citations"] {
  const deduped: ChatThreadTurnRecord["citations"] = [];
  const seen = new Map<string, number>();
  for (const citation of citations) {
    const key = citation.knowledge
      ? `knowledge:${citation.knowledge.attachmentId}:${citation.knowledge.chunkId ?? citation.knowledge.sourceRef}:${citation.knowledge.retrievalMode}`
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
  // Every duplicate either merges into an earlier slot or is dropped, so an equal
  // length means nothing changed — keep the original array's identity.
  return deduped.length === citations.length ? citations : deduped;
}
