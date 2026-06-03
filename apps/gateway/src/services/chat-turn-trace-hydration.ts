/**
 * Chat turn trace hydration helpers.
 *
 * Read-only trace hydration and branch/tree derivation helpers over a minimal
 * storage deps.
 */

import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolveNewestLeafTurnId } from "./chat-thread-utils.js";

type ChatTurnTraceHydrationStorage = Pick<
  Storage,
  "chatExecutionPlans" | "chatSessionBranchState" | "chatToolRuns" | "chatTurnTraces"
>;

export interface ChatTurnTraceHydrationDependencies {
  readonly storage: ChatTurnTraceHydrationStorage;
}

export function createHydratedChatTurnTrace(
  deps: ChatTurnTraceHydrationDependencies,
  turnId: string,
  trace: ChatTurnTraceRecord,
): ChatTurnTraceRecord {
  return {
    ...trace,
    toolRuns: deps.storage.chatToolRuns.listByTurn(turnId),
    citations: trace.citations ?? [],
  };
}

export function listHydratedChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  sessionId: string,
  limit = 200,
): ChatTurnTraceRecord[] {
  const traces = deps.storage.chatTurnTraces.listBySession(sessionId, limit);
  return hydrateChatTurnTraces(deps, traces);
}

export function hydrateChatTurnTraces(
  deps: ChatTurnTraceHydrationDependencies,
  traces: ChatTurnTraceRecord[],
): ChatTurnTraceRecord[] {
  const toolRunsByTurnId = deps.storage.chatToolRuns.listByTurnIds(traces.map((trace) => trace.turnId));
  const executionPlanIds = [
    ...new Set(traces.map((trace) => trace.executionPlanId).filter((item): item is string => Boolean(item))),
  ];
  const executionPlansById = new Map(
    executionPlanIds
      .map((executionPlanId) => {
        try {
          return [executionPlanId, deps.storage.chatExecutionPlans.get(executionPlanId)] as const;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is readonly [string, ReturnType<typeof deps.storage.chatExecutionPlans.get>] =>
        Boolean(entry),
      ),
  );
  return traces.map((trace) => ({
    ...trace,
    toolRuns: toolRunsByTurnId.get(trace.turnId) ?? [],
    citations: trace.citations ?? [],
    executionPlan: trace.executionPlanId ? executionPlansById.get(trace.executionPlanId) : undefined,
    capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
  }));
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
