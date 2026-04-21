import type {
  ChatGeneratedArtifactReference,
  ChatMessageRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";

interface ThreadTurnInput {
  trace: ChatTurnTraceRecord;
  userMessage?: ChatMessageRecord;
  assistantMessage?: ChatMessageRecord;
  generatedArtifacts?: ChatGeneratedArtifactReference[];
}

interface ThreadNode extends ThreadTurnInput {
  turnId: string;
  startedAtMs: number;
}

export function buildChatThreadResponse(input: {
  sessionId: string;
  activeLeafTurnId?: string;
  turns: ThreadTurnInput[];
}): ChatThreadResponse {
  const nodes = input.turns
    .filter((item): item is ThreadNode => Boolean(item.userMessage))
    .map((item) => ({
      ...item,
      turnId: item.trace.turnId,
      startedAtMs: Date.parse(item.trace.startedAt) || 0,
    }))
    .sort((left, right) => {
      if (left.startedAtMs !== right.startedAtMs) {
        return left.startedAtMs - right.startedAtMs;
      }
      return left.turnId.localeCompare(right.turnId);
    });

  if (nodes.length === 0) {
    return {
      sessionId: input.sessionId,
      activeLeafTurnId: undefined,
      selectedTurnId: undefined,
      turns: [],
    };
  }

  const byId = new Map(nodes.map((node) => [node.turnId, node]));
  const validActiveLeafTurnId =
    input.activeLeafTurnId && byId.has(input.activeLeafTurnId) ? input.activeLeafTurnId : nodes.at(-1)?.turnId;
  if (!validActiveLeafTurnId) {
    return {
      sessionId: input.sessionId,
      activeLeafTurnId: undefined,
      selectedTurnId: undefined,
      turns: [],
    };
  }

  const siblingIdsByParent = new Map<string, string[]>();
  const childrenByTurnId = new Map<string, string[]>();
  for (const node of nodes) {
    const parentKey = toParentKey(node.trace.parentTurnId);
    const siblings = siblingIdsByParent.get(parentKey) ?? [];
    siblings.push(node.turnId);
    siblingIdsByParent.set(parentKey, siblings);
    if (node.trace.parentTurnId) {
      const children = childrenByTurnId.get(node.trace.parentTurnId) ?? [];
      children.push(node.turnId);
      childrenByTurnId.set(node.trace.parentTurnId, children);
    }
  }

  const selectedPathTurnIds = buildSelectedPathTurnIds(
    new Map(
      nodes.map((node) => [
        node.turnId,
        {
          turnId: node.turnId,
          parentTurnId: node.trace.parentTurnId,
        },
      ]),
    ),
    validActiveLeafTurnId,
  );
  const newestLeafCache = new Map<string, string>();
  const turns = selectedPathTurnIds
    .map((turnId) => byId.get(turnId))
    .filter((item): item is ThreadNode => Boolean(item))
    .map((node): ChatThreadTurnRecord => {
      const siblingTurnIds = [...(siblingIdsByParent.get(toParentKey(node.trace.parentTurnId)) ?? [node.turnId])];
      const newestLeafTurnId = resolveNewestLeafTurnId(node.turnId, byId, childrenByTurnId, newestLeafCache);
      return {
        turnId: node.turnId,
        parentTurnId: node.trace.parentTurnId,
        branchKind: node.trace.branchKind,
        sourceTurnId: node.trace.sourceTurnId,
        userMessage: node.userMessage!,
        assistantMessage: node.assistantMessage,
        trace: node.trace,
        toolRuns: node.trace.toolRuns,
        citations: node.trace.citations,
        generatedArtifacts: node.generatedArtifacts,
        branch: {
          siblingTurnIds,
          activeSiblingIndex: Math.max(0, siblingTurnIds.indexOf(node.turnId)),
          siblingCount: siblingTurnIds.length,
          isSelectedPath: true,
          newestLeafTurnId,
        },
      };
    });

  return {
    sessionId: input.sessionId,
    activeLeafTurnId: validActiveLeafTurnId,
    selectedTurnId: validActiveLeafTurnId,
    turns,
  };
}

export function buildSelectedPathTurnIds(
  turnsById: Map<string, { turnId: string; parentTurnId?: string }>,
  activeLeafTurnId: string,
  options: { maxDepth?: number } = {},
): string[] {
  const maxDepth = options.maxDepth ?? 2048;
  const ordered: string[] = [];
  let currentTurnId: string | undefined = activeLeafTurnId;
  const seen = new Set<string>();
  while (currentTurnId && !seen.has(currentTurnId) && ordered.length < maxDepth) {
    seen.add(currentTurnId);
    ordered.push(currentTurnId);
    currentTurnId = turnsById.get(currentTurnId)?.parentTurnId;
  }
  ordered.reverse();
  return ordered;
}

export function resolveNewestLeafTurnId(
  rootTurnId: string,
  turnsById: Map<string, Pick<ThreadNode, "turnId" | "startedAtMs">>,
  childrenByTurnId: Map<string, string[]>,
  cache = new Map<string, string>(),
): string {
  const cached = cache.get(rootTurnId);
  if (cached) {
    return cached;
  }

  const children = childrenByTurnId.get(rootTurnId) ?? [];
  if (children.length === 0) {
    cache.set(rootTurnId, rootTurnId);
    return rootTurnId;
  }

  let bestTurnId = rootTurnId;
  let bestStartedAtMs = turnsById.get(rootTurnId)?.startedAtMs ?? 0;
  for (const childTurnId of children) {
    const candidateTurnId = resolveNewestLeafTurnId(childTurnId, turnsById, childrenByTurnId, cache);
    const candidateStartedAtMs = turnsById.get(candidateTurnId)?.startedAtMs ?? 0;
    if (
      candidateStartedAtMs > bestStartedAtMs ||
      (candidateStartedAtMs === bestStartedAtMs && candidateTurnId.localeCompare(bestTurnId) > 0)
    ) {
      bestTurnId = candidateTurnId;
      bestStartedAtMs = candidateStartedAtMs;
    }
  }

  cache.set(rootTurnId, bestTurnId);
  return bestTurnId;
}

function toParentKey(parentTurnId: string | undefined): string {
  return parentTurnId ?? "__root__";
}
