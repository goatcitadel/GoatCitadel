/**
 * Chat turn trace hydration helpers.
 *
 * Step 8a of the gateway-service decomposition plan: read-only trace
 * hydration and branch/tree derivation helpers extracted from
 * GatewayService. Pure functions over a minimal storage Host interface.
 */

import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { resolveNewestLeafTurnId } from "./chat-thread-utils.js";
import type { GatewayService } from "./gateway-service.js";

export type ChatTurnTraceHydrationHost = GatewayService;

export function createHydratedChatTurnTrace(
  host: ChatTurnTraceHydrationHost,
  turnId: string,
  trace: ChatTurnTraceRecord,
): ChatTurnTraceRecord {
  return {
    ...trace,
    toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
    citations: trace.citations ?? [],
  };
}

export function listHydratedChatTurnTraces(
  host: ChatTurnTraceHydrationHost,
  sessionId: string,
  limit = 200,
): ChatTurnTraceRecord[] {
  const traces = host.storage.chatTurnTraces.listBySession(sessionId, limit);
  const toolRunsByTurnId = host.storage.chatToolRuns.listByTurnIds(traces.map((trace) => trace.turnId));
  const executionPlansById = new Map(
    traces
      .filter((trace) => trace.executionPlanId)
      .map((trace) => {
        try {
          return [trace.executionPlanId!, host.storage.chatExecutionPlans.get(trace.executionPlanId!)] as const;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is readonly [string, ReturnType<typeof host.storage.chatExecutionPlans.get>] =>
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
  for (const trace of traces) {
    if (!trace.parentTurnId) {
      continue;
    }
    const children = childrenByTurnId.get(trace.parentTurnId) ?? [];
    children.push(trace.turnId);
    childrenByTurnId.set(trace.parentTurnId, children);
  }
  return childrenByTurnId;
}

export function resolveChatActiveLeafTurnId(
  host: ChatTurnTraceHydrationHost,
  sessionId: string,
  traces: ChatTurnTraceRecord[],
): string | undefined {
  const branchState = host.storage.chatSessionBranchState.get(sessionId);
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
  host.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId, newest.finishedAt ?? newest.startedAt);
  return newestLeafTurnId;
}
