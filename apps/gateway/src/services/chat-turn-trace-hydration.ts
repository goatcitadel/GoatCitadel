/**
 * Chat turn trace hydration helpers.
 *
 * Read-only trace hydration and branch/tree derivation helpers over a minimal
 * storage deps.
 */

import type { ChatMessageRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
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

export function createHydratedChatTurnTrace(
  deps: ChatTurnTraceHydrationDependencies,
  turnId: string,
  trace: ChatTurnTraceRecord,
  options?: ChatTurnTraceHydrationOptions,
): ChatTurnTraceRecord {
  return {
    ...trace,
    toolRuns: deps.storage.chatToolRuns.listByTurn(turnId),
    citations: trace.citations ?? [],
    ...(options?.includeDecisionTrace && deps.storage.runtimeDecisionTraces
      ? { decisionTrace: deps.storage.runtimeDecisionTraces.list({ turnId, limit: 100 }) }
      : {}),
  };
}

export function listHydratedChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  limit = 200,
  options?: ChatTurnTraceHydrationOptions,
): ChatTurnTraceRecord[] {
  const traces = deps.storage.chatTurnTraces.listBySession(sessionId, limit);
  return hydrateChatTurnTraces(deps, traces, options);
}

export function hydrateChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
  options?: ChatTurnTraceHydrationOptions,
): ChatTurnTraceRecord[] {
  const toolRunsByTurnId = deps.storage.chatToolRuns.listByTurnIds(traces.map((trace) => trace.turnId));
  const executionPlansById = loadExecutionPlansById(deps, traces);
  const decisionTraceByTurnId = options?.includeDecisionTrace ? loadDecisionTraceByTurnId(deps, traces) : new Map();

  return traces.map((trace) => ({
    ...trace,
    toolRuns: toolRunsByTurnId.get(trace.turnId) ?? [],
    citations: trace.citations ?? [],
    executionPlan: trace.executionPlanId ? executionPlansById.get(trace.executionPlanId) : undefined,
    decisionTrace: decisionTraceByTurnId.get(trace.turnId) ?? trace.decisionTrace,
    capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
  }));
}

function loadExecutionPlansById(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
): Map<string, ReturnType<Storage["chatExecutionPlans"]["get"]>> {
  const executionPlanIds = [
    ...new Set(traces.map((trace) => trace.executionPlanId).filter((item): item is string => Boolean(item))),
  ];
  return new Map(
    executionPlanIds
      .map((executionPlanId) => {
        try {
          return [executionPlanId, deps.storage.chatExecutionPlans.get(executionPlanId)] as const;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is readonly [string, ReturnType<Storage["chatExecutionPlans"]["get"]>] => Boolean(entry)),
  );
}

function loadDecisionTraceByTurnId(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
): Map<string, NonNullable<ChatTurnTraceRecord["decisionTrace"]>> {
  if (!deps.storage.runtimeDecisionTraces || traces.length === 0) {
    return new Map();
  }
  const sessionId = traces[0]?.sessionId;
  if (!sessionId) {
    return new Map();
  }
  const records = deps.storage.runtimeDecisionTraces.list({
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

export function resolveChatActiveLeafTurnId(
  deps: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  traces: ChatTurnTraceRecord[],
): string | undefined {
  const branchState = deps.storage.chatSessionBranchState.get(sessionId);
  if (branchState && traces.some((trace) => trace.turnId === branchState.activeLeafTurnId)) {
    return branchState.activeLeafTurnId;
  }
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
  deps.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId, newest.finishedAt ?? newest.startedAt);
  return newestLeafTurnId;
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
  options: { includeDecisionTrace?: boolean } = {},
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
  const rawTraces = deps.storage.chatTurnTraces.listBySession(sessionId, 2_000);
  const turnLineageById = new Map(
    rawTraces.map((trace) => [
      trace.turnId,
      {
        turnId: trace.turnId,
        parentTurnId: trace.parentTurnId,
      },
    ]),
  );
  const activeLeafTurnId = resolveChatActiveLeafTurnId(deps, sessionId, rawTraces);
  const selectedPathTurnIds = activeLeafTurnId ? buildSelectedPathTurnIds(turnLineageById, activeLeafTurnId) : [];
  const rawTraceById = new Map(rawTraces.map((trace) => [trace.turnId, trace]));
  const pathParentTurnIds = selectedPathTurnIds.map((turnId) => rawTraceById.get(turnId)?.parentTurnId);
  const siblingTracesByParent = deps.storage.chatTurnTraces.listSiblingsByParentTurnIds(sessionId, pathParentTurnIds);
  const visibleTurnIds = new Set(selectedPathTurnIds);
  for (const siblings of siblingTracesByParent.values()) {
    for (const sibling of siblings) {
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
    hydrateChatTurnTraces(deps, visibleRawTraces, {
      includeDecisionTrace: options.includeDecisionTrace === true,
    }).map((trace) => [trace.turnId, trace]),
  );
  const traces = rawTraces.map((trace) => hydratedVisibleTracesById.get(trace.turnId) ?? trace);
  const messageIds = visibleRawTraces.flatMap((trace) => [
    trace.userMessageId,
    ...(trace.assistantMessageId ? [trace.assistantMessageId] : []),
  ]);
  const messagesById = deps.storage.chatMessages.listByMessageIds(messageIds);
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
    childrenByTurnId: buildChatTurnChildrenMap(traces),
    activeLeafTurnId,
  };
}
