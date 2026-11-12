/**
 * Chat turn trace hydration helpers.
 *
 * Read-only trace hydration and branch/tree derivation helpers over a minimal
 * storage deps.
 */

import type { ChatMessageRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { buildSelectedPathTurnIds, resolveNewestLeafTurnId } from "./chat-thread-utils.js";

type ChatTurnTraceHydrationStorage = Pick<
  Storage,
  "chatExecutionPlans" | "chatSessionBranchState" | "chatToolRuns" | "chatTurnTraces"
> &
  Partial<Pick<Storage, "runtimeDecisionTraces">>;

export interface ChatTurnTraceHydrationDependencies {
  readonly storage: ChatTurnTraceHydrationStorage;
}

export interface ChatTurnTraceHydrationOptions {
  includeDecisionTrace?: boolean;
}

export interface LoadChatTurnSessionStateOptions extends ChatTurnTraceHydrationOptions {
  /**
   * Internal projection boundary for callers that retain non-conversation
   * traces alongside Chat. Excluded traces remain available in `traces`, but
   * cannot become branch leaves or cause their hidden messages to hydrate.
   */
  isConversationTrace?: (trace: ChatTurnTraceRecord) => boolean;
}

export async function createHydratedChatTurnTrace(
  deps: ChatTurnTraceHydrationDependencies,
  turnId: string,
  trace: ChatTurnTraceRecord,
  options?: ChatTurnTraceHydrationOptions,
): Promise<ChatTurnTraceRecord> {
  return {
    ...trace,
    toolRuns: await deps.storage.chatToolRuns.listByTurn(turnId),
    citations: trace.citations ?? [],
    ...(options?.includeDecisionTrace && deps.storage.runtimeDecisionTraces
      ? { decisionTrace: await deps.storage.runtimeDecisionTraces.list({ turnId, limit: 100 }) }
      : {}),
  };
}

export async function listHydratedChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  limit = 200,
  options?: ChatTurnTraceHydrationOptions,
): Promise<ChatTurnTraceRecord[]> {
  const traces = await deps.storage.chatTurnTraces.listBySession(sessionId, limit);
  return await hydrateChatTurnTraces(deps, traces, options);
}

export async function hydrateChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
  options?: ChatTurnTraceHydrationOptions,
): Promise<ChatTurnTraceRecord[]> {
  const toolRunsByTurnId = await deps.storage.chatToolRuns.listByTurnIds(traces.map((trace) => trace.turnId));
  const executionPlansById = await loadExecutionPlansById(deps, traces);
  const decisionTraceByTurnId = options?.includeDecisionTrace
    ? await loadDecisionTraceByTurnId(deps, traces)
    : new Map();

  return traces.map((trace) => ({
    ...trace,
    toolRuns: toolRunsByTurnId.get(trace.turnId) ?? [],
    citations: trace.citations ?? [],
    executionPlan: trace.executionPlanId ? executionPlansById.get(trace.executionPlanId) : undefined,
    decisionTrace: decisionTraceByTurnId.get(trace.turnId) ?? trace.decisionTrace,
    capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
  }));
}

async function loadExecutionPlansById(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
): Promise<Map<string, Awaited<ReturnType<Storage["chatExecutionPlans"]["get"]>>>> {
  const executionPlanIds = [
    ...new Set(traces.map((trace) => trace.executionPlanId).filter((item): item is string => Boolean(item))),
  ];
  return new Map(
    (
      await Promise.all(
        executionPlanIds.map(async (executionPlanId) => {
          try {
            return [executionPlanId, await deps.storage.chatExecutionPlans.get(executionPlanId)] as const;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((entry): entry is readonly [string, Awaited<ReturnType<Storage["chatExecutionPlans"]["get"]>>] =>
      Boolean(entry),
    ),
  );
}

async function loadDecisionTraceByTurnId(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
): Promise<Map<string, NonNullable<ChatTurnTraceRecord["decisionTrace"]>>> {
  if (!deps.storage.runtimeDecisionTraces || traces.length === 0) {
    return new Map();
  }
  const sessionId = traces[0]?.sessionId;
  if (!sessionId) {
    return new Map();
  }
  const records = await deps.storage.runtimeDecisionTraces.list({
    sessionId,
    limit: Math.max(100, Math.min(traces.length * 40, 500)),
  });
  const requestedTurnIds = new Set(traces.map((trace) => trace.turnId));
  const grouped = new Map<string, NonNullable<ChatTurnTraceRecord["decisionTrace"]>>();
  for (const record of records) {
    const turnId = record.scope.turnId;
    if (!turnId || !requestedTurnIds.has(turnId)) {
      continue;
    }
    const current = grouped.get(turnId) ?? [];
    current.push(record);
    grouped.set(turnId, current);
  }
  return grouped;
}

export function buildChatTurnChildrenMap(traces: ChatTurnTraceRecord[]): Map<string, string[]> {
  const childrenByTurnId = new Map<string, string[]>();
  const turnIds = new Set(traces.map((trace) => trace.turnId));
  for (const trace of traces) {
    if (!trace.parentTurnId || trace.parentTurnId === trace.turnId || !turnIds.has(trace.parentTurnId)) {
      continue;
    }
    const children = childrenByTurnId.get(trace.parentTurnId) ?? [];
    children.push(trace.turnId);
    childrenByTurnId.set(trace.parentTurnId, children);
  }
  return childrenByTurnId;
}

export async function resolveChatActiveLeafTurnId(
  deps: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  traces: ChatTurnTraceRecord[],
): Promise<string | undefined> {
  return (await resolveChatActiveLeaf(deps, sessionId, traces))?.turnId;
}

async function resolveChatActiveLeaf(
  { storage: { chatSessionBranchState, chatTurnTraces } }: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  traces: ChatTurnTraceRecord[],
  isConversationTrace?: LoadChatTurnSessionStateOptions["isConversationTrace"],
): Promise<ChatTurnTraceRecord | undefined> {
  const resolveLeaf = async (leafTurnId: string | undefined): Promise<ChatTurnTraceRecord | undefined> => {
    if (!leafTurnId) return undefined;
    const visible = traces.find((trace) => trace.turnId === leafTurnId);
    if (visible) return visible;
    // An exact same-session leaf can sit outside the bounded or stale list.
    const exact = (await chatTurnTraces.getByTurnIds([leafTurnId])).get(leafTurnId);
    return exact?.sessionId === sessionId && (!isConversationTrace || isConversationTrace(exact)) ? exact : undefined;
  };

  const observed = await chatSessionBranchState.get(sessionId);
  const persisted = await resolveLeaf(observed?.activeLeafTurnId);
  if (persisted) return persisted;

  const newest = [...traces]
    .sort((left, right) => {
      const leftStarted = Date.parse(left.startedAt) || 0;
      const rightStarted = Date.parse(right.startedAt) || 0;
      if (leftStarted !== rightStarted) {
        return rightStarted - leftStarted;
      }
      return right.turnId.localeCompare(left.turnId);
    })
    .at(0);
  if (!newest) {
    if (
      isConversationTrace &&
      observed &&
      !(await chatSessionBranchState.clearIfCurrent(sessionId, observed.activeLeafTurnId))
    ) {
      return await resolveLeaf((await chatSessionBranchState.get(sessionId))?.activeLeafTurnId);
    }
    return undefined;
  }
  const newestLeafTurnId = resolveNewestLeafTurnId(
    newest.turnId,
    new Map(
      traces.map((trace) => [
        trace.turnId,
        {
          turnId: trace.turnId,
          startedAtMs: Date.parse(trace.startedAt) || 0,
        },
      ]),
    ),
    buildChatTurnChildrenMap(traces),
  );
  const updated = await chatSessionBranchState.setActiveLeafIfCurrent(
    sessionId,
    observed?.activeLeafTurnId,
    newestLeafTurnId,
    newest.finishedAt ?? newest.startedAt,
  );
  if (!updated) {
    return await resolveLeaf((await chatSessionBranchState.get(sessionId))?.activeLeafTurnId);
  }
  return traces.find((trace) => trace.turnId === newestLeafTurnId) ?? newest;
}

export interface LoadChatTurnSessionStateDeps extends ChatTurnTraceHydrationDependencies {
  storage: ChatTurnTraceHydrationDependencies["storage"] & Pick<Storage, "chatMessages">;
  ensureChatMessageProjection(sessionId: string): Promise<void>;
}

/**
 * Load a session's turn state for the thread surface: full lineage, the
 * hydrated visible window (active-leaf path plus its siblings — hydration is
 * deliberately limited to what the surface renders), and the visible turns'
 * messages sorted by timestamp. Extracted from GatewayService (B3b).
 */
export async function loadChatTurnSessionState(
  deps: LoadChatTurnSessionStateDeps,
  sessionId: string,
  options: LoadChatTurnSessionStateOptions = {},
): Promise<{
  traces: ChatTurnTraceRecord[];
  tracesById: Map<string, ChatTurnTraceRecord>;
  turnLineageById: Map<string, { turnId: string; parentTurnId?: string }>;
  messages: ChatMessageRecord[];
  messagesById: Map<string, ChatMessageRecord>;
  childrenByTurnId: Map<string, string[]>;
  activeLeafTurnId?: string;
}> {
  await deps.ensureChatMessageProjection(sessionId);
  const { chatTurnTraces } = deps.storage;
  const listedTraces = await chatTurnTraces.listBySession(sessionId, 1_000);
  const listedConversationTraces = options.isConversationTrace
    ? listedTraces.filter(options.isConversationTrace)
    : listedTraces;
  const activeLeaf = await resolveChatActiveLeaf(
    deps,
    sessionId,
    listedConversationTraces,
    options.isConversationTrace,
  );
  const activeLeafTurnId = activeLeaf?.turnId;
  let rawTraces =
    activeLeaf && !listedConversationTraces.includes(activeLeaf)
      ? [...listedTraces.filter((trace) => trace.turnId !== activeLeaf.turnId), activeLeaf].sort((left, right) =>
          right.startedAt.localeCompare(left.startedAt),
        )
      : listedTraces;
  const conversationTraces =
    rawTraces === listedTraces
      ? listedConversationTraces
      : options.isConversationTrace
        ? rawTraces.filter(options.isConversationTrace)
        : rawTraces;
  const turnLineageById = new Map(
    conversationTraces.map((trace) => [
      trace.turnId,
      {
        turnId: trace.turnId,
        parentTurnId: trace.parentTurnId,
      },
    ]),
  );
  const rawTraceById = new Map(rawTraces.map((trace) => [trace.turnId, trace]));
  let selectedPathTurnIds = activeLeafTurnId ? buildSelectedPathTurnIds(turnLineageById, activeLeafTurnId) : [];
  const missingAncestorId = selectedPathTurnIds[0];
  if (activeLeafTurnId && missingAncestorId && !rawTraceById.has(missingAncestorId)) {
    const olderTraces = await chatTurnTraces.listLineageFrom(sessionId, missingAncestorId);
    const added: ChatTurnTraceRecord[] = [];
    for (const trace of olderTraces) {
      if (trace.sessionId !== sessionId || (options.isConversationTrace && !options.isConversationTrace(trace))) break;
      if (rawTraceById.has(trace.turnId)) continue;
      rawTraceById.set(trace.turnId, trace);
      turnLineageById.set(trace.turnId, { turnId: trace.turnId, parentTurnId: trace.parentTurnId });
      added.push(trace);
    }
    if (added.length) {
      rawTraces = [...rawTraces, ...added].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      selectedPathTurnIds = buildSelectedPathTurnIds(turnLineageById, activeLeafTurnId);
    }
  }
  const pathParentTurnIds = selectedPathTurnIds.map((turnId) => rawTraceById.get(turnId)?.parentTurnId);
  const siblingTracesByParent = await chatTurnTraces.listSiblingsByParentTurnIds(sessionId, pathParentTurnIds);
  const visibleTurnIds = new Set(selectedPathTurnIds);
  for (const siblings of siblingTracesByParent.values()) {
    for (const sibling of siblings) {
      if (options.isConversationTrace && !options.isConversationTrace(sibling)) {
        continue;
      }
      visibleTurnIds.add(sibling.turnId);
      if (!rawTraceById.has(sibling.turnId)) {
        rawTraceById.set(sibling.turnId, sibling);
      }
    }
  }
  const visibleRawTraces = [...visibleTurnIds]
    .map((turnId) => rawTraceById.get(turnId))
    .filter((trace): trace is ChatTurnTraceRecord => Boolean(trace));
  const hydratedVisibleTracesById = new Map(
    (
      await hydrateChatTurnTraces(deps, visibleRawTraces, {
        includeDecisionTrace: options.includeDecisionTrace === true,
      })
    ).map((trace) => [trace.turnId, trace]),
  );
  const traces = rawTraces.map((trace) => hydratedVisibleTracesById.get(trace.turnId) ?? trace);
  const messageIds = visibleRawTraces.flatMap((trace) => [
    trace.userMessageId,
    ...(trace.assistantMessageId ? [trace.assistantMessageId] : []),
  ]);
  const messagesById = await deps.storage.chatMessages.listByMessageIds(messageIds);
  const messages = [...messagesById.values()].sort((left, right) => {
    const leftTimestamp = Date.parse(left.timestamp) || 0;
    const rightTimestamp = Date.parse(right.timestamp) || 0;
    if (leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }
    return left.messageId.localeCompare(right.messageId);
  });
  return {
    traces,
    tracesById: new Map(traces.map((trace) => [trace.turnId, trace])),
    turnLineageById,
    messages,
    messagesById,
    childrenByTurnId: buildChatTurnChildrenMap(
      options.isConversationTrace ? traces.filter((trace) => turnLineageById.has(trace.turnId)) : traces,
    ),
    activeLeafTurnId,
  };
}
