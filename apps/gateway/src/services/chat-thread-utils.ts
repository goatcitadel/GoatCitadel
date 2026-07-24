import type {
  ChatGeneratedArtifactReference,
  ChatMessageRecord,
  ChatThreadResponse,
  ChatThreadSystemNoticeRecord,
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
  parentTurnId?: string;
  startedAtMs: number;
}

export const CHAT_THREAD_SYSTEM_NOTICE_LIMIT = 60;

export function buildChatThreadResponse(input: {
  sessionId: string;
  activeLeafTurnId?: string;
  turns: ThreadTurnInput[];
  systemNotices?: ChatThreadSystemNoticeRecord[];
  systemNoticeHiddenCount?: number;
}): ChatThreadResponse {
  const orderedSystemNotices = [...(input.systemNotices ?? [])].sort((left, right) => {
    const timestampOrder = toTimestampMs(left.message.timestamp) - toTimestampMs(right.message.timestamp);
    return timestampOrder || left.noticeId.localeCompare(right.noticeId);
  });
  const locallyHiddenSystemNoticeCount = Math.max(0, orderedSystemNotices.length - CHAT_THREAD_SYSTEM_NOTICE_LIMIT);
  const systemNotices = locallyHiddenSystemNoticeCount
    ? orderedSystemNotices.slice(locallyHiddenSystemNoticeCount)
    : orderedSystemNotices;
  const systemNoticeHiddenCount = Math.max(0, input.systemNoticeHiddenCount ?? 0) + locallyHiddenSystemNoticeCount;
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
      systemNotices,
      systemNoticeHiddenCount,
    };
  }

  const byId = new Map(nodes.map((node) => [node.turnId, node]));
  for (const node of nodes) {
    node.parentTurnId = resolveValidParentTurnId(node.trace.parentTurnId, node.turnId, byId);
  }
  const validActiveLeafTurnId =
    input.activeLeafTurnId && byId.has(input.activeLeafTurnId) ? input.activeLeafTurnId : nodes.at(-1)?.turnId;
  if (!validActiveLeafTurnId) {
    return {
      sessionId: input.sessionId,
      activeLeafTurnId: undefined,
      selectedTurnId: undefined,
      turns: [],
      systemNotices,
      systemNoticeHiddenCount,
    };
  }

  const siblingIdsByParent = new Map<string, string[]>();
  const childrenByTurnId = new Map<string, string[]>();
  for (const node of nodes) {
    const parentKey = toParentKey(node.parentTurnId);
    const siblings = siblingIdsByParent.get(parentKey) ?? [];
    siblings.push(node.turnId);
    siblingIdsByParent.set(parentKey, siblings);
    if (node.parentTurnId) {
      const children = childrenByTurnId.get(node.parentTurnId) ?? [];
      children.push(node.turnId);
      childrenByTurnId.set(node.parentTurnId, children);
    }
  }

  const selectedPathTurnIds = buildSelectedPathTurnIds(
    new Map(
      nodes.map((node) => [
        node.turnId,
        {
          turnId: node.turnId,
          parentTurnId: node.parentTurnId,
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
      const siblingTurnIds = [...(siblingIdsByParent.get(toParentKey(node.parentTurnId)) ?? [node.turnId])];
      const newestLeafTurnId = resolveNewestLeafTurnId(node.turnId, byId, childrenByTurnId, newestLeafCache);
      return {
        turnId: node.turnId,
        parentTurnId: node.parentTurnId,
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
    systemNotices,
    systemNoticeHiddenCount,
  };
}

function toTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  visiting = new Set<string>(),
): string {
  const cached = cache.get(rootTurnId);
  if (cached) {
    return cached;
  }

  if (visiting.has(rootTurnId)) {
    return rootTurnId;
  }

  visiting.add(rootTurnId);
  const children = (childrenByTurnId.get(rootTurnId) ?? []).filter(
    (childTurnId) => childTurnId !== rootTurnId && turnsById.has(childTurnId),
  );
  if (children.length === 0) {
    visiting.delete(rootTurnId);
    cache.set(rootTurnId, rootTurnId);
    return rootTurnId;
  }

  let bestTurnId = rootTurnId;
  let bestStartedAtMs = turnsById.get(rootTurnId)?.startedAtMs ?? 0;
  for (const childTurnId of children) {
    if (visiting.has(childTurnId)) {
      continue;
    }
    const candidateTurnId = resolveNewestLeafTurnId(childTurnId, turnsById, childrenByTurnId, cache, visiting);
    const candidateStartedAtMs = turnsById.get(candidateTurnId)?.startedAtMs ?? 0;
    if (
      candidateStartedAtMs > bestStartedAtMs ||
      (candidateStartedAtMs === bestStartedAtMs && candidateTurnId.localeCompare(bestTurnId) > 0)
    ) {
      bestTurnId = candidateTurnId;
      bestStartedAtMs = candidateStartedAtMs;
    }
  }

  visiting.delete(rootTurnId);
  cache.set(rootTurnId, bestTurnId);
  return bestTurnId;
}

function resolveValidParentTurnId(
  parentTurnId: string | undefined,
  turnId: string,
  turnsById: Map<string, Pick<ThreadNode, "turnId">>,
): string | undefined {
  if (!parentTurnId || parentTurnId === turnId || !turnsById.has(parentTurnId)) {
    return undefined;
  }
  return parentTurnId;
}

function toParentKey(parentTurnId: string | undefined): string {
  return parentTurnId ?? "__root__";
}
