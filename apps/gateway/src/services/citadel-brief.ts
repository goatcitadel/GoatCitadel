import type {
  ApprovalRequest,
  CitadelBrief,
  CitadelBriefApprovalEntry,
  RealtimeEvent,
  WorkspaceRecord,
} from "@goatcitadel/contracts";

export type { CitadelBrief, CitadelBriefApprovalEntry };

/**
 * Pure composition for the per-Citadel operator brief ("what happened while I
 * was away"). The route gathers raw slices from existing services; everything
 * here is derivation only, so the whole read model is unit-testable without a
 * gateway. Approval entries are projected down to safe scalars — never the
 * payload/preview bodies — because the brief is a summary surface, not an
 * approval console.
 */

export interface CitadelBriefCostSlice {
  key: string;
  costUsd: number;
  tokenTotal: number;
  metricAvailability?: { costUsdComplete: boolean };
}

export interface CitadelBriefMemorySlice {
  status?: string;
}

export interface CitadelBriefInput {
  citadelId: string;
  citadelName?: string;
  since: string;
  generatedAt: string;
  workspaces: ReadonlyArray<Pick<WorkspaceRecord, "workspaceId" | "name">>;
  pendingApprovalsByWorkspace: ReadonlyArray<{ workspaceId: string; items: readonly ApprovalRequest[] }>;
  events: readonly RealtimeEvent[];
  costSummaries: readonly CitadelBriefCostSlice[];
  memory: { recommendations: readonly CitadelBriefMemorySlice[] } | { unavailable: string };
}

const COMPLETED_EVENT_RE = /(?:^|[._-])(?:completed|succeeded)$/;
const FAILED_EVENT_RE = /(?:^|[._-])(?:failed|errored)$/;
const WARD_EVENT_RE = /ward/i;
const MAX_PENDING_APPROVAL_ENTRIES = 50;
const MAX_EVENT_TYPES = 12;
const PENDING_RECOMMENDATION_STATUSES = new Set(["pending", "proposed", "open"]);

export function composeCitadelBrief(input: CitadelBriefInput): CitadelBrief {
  const generatedAtMs = Date.parse(input.generatedAt);
  const sinceMs = Date.parse(input.since);

  const pending = input.pendingApprovalsByWorkspace
    .flatMap(({ workspaceId, items }) =>
      items
        .filter((item) => item.status === "pending")
        .map(
          (item): CitadelBriefApprovalEntry => ({
            approvalId: item.approvalId,
            workspaceId,
            kind: item.kind,
            riskLevel: item.riskLevel,
            createdAt: item.createdAt,
            ageMs: Math.max(0, generatedAtMs - Date.parse(item.createdAt)),
            ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
          }),
        ),
    )
    .sort((a, b) => b.ageMs - a.ageMs);

  const eventsSince = input.events.filter((event) => {
    const at = Date.parse(event.timestamp);
    return Number.isFinite(at) && at >= sinceMs && at <= generatedAtMs;
  });
  const typeCounts = new Map<string, number>();
  let completedSince = 0;
  let failedSince = 0;
  let wardHitsSince = 0;
  for (const event of eventsSince) {
    const eventType = String(event.eventType);
    typeCounts.set(eventType, (typeCounts.get(eventType) ?? 0) + 1);
    if (COMPLETED_EVENT_RE.test(eventType)) {
      completedSince += 1;
    }
    if (FAILED_EVENT_RE.test(eventType)) {
      failedSince += 1;
    }
    if (WARD_EVENT_RE.test(eventType)) {
      wardHitsSince += 1;
    }
  }
  const byType = [...typeCounts.entries()]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType))
    .slice(0, MAX_EVENT_TYPES);

  let sinceUsd = 0;
  let sinceTokens = 0;
  let complete = true;
  for (const slice of input.costSummaries) {
    sinceUsd += Number.isFinite(slice.costUsd) ? slice.costUsd : 0;
    sinceTokens += Number.isFinite(slice.tokenTotal) ? slice.tokenTotal : 0;
    if (slice.metricAvailability && !slice.metricAvailability.costUsdComplete) {
      complete = false;
    }
  }

  const memory =
    "unavailable" in input.memory
      ? { unavailable: input.memory.unavailable }
      : {
          pendingRecommendations: input.memory.recommendations.filter(
            (item) => !item.status || PENDING_RECOMMENDATION_STATUSES.has(item.status),
          ).length,
        };

  return {
    citadelId: input.citadelId,
    ...(input.citadelName ? { citadelName: input.citadelName } : {}),
    since: input.since,
    generatedAt: input.generatedAt,
    workspaces: input.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
    })),
    approvals: {
      pendingCount: pending.length,
      oldestAgeMs: pending.length > 0 ? pending[0]!.ageMs : null,
      pending: pending.slice(0, MAX_PENDING_APPROVAL_ENTRIES),
    },
    activity: {
      eventsSince: eventsSince.length,
      completedSince,
      failedSince,
      wardHitsSince,
      byType,
    },
    spend: {
      scope: "instance",
      sinceUsd,
      sinceTokens,
      complete,
    },
    memory,
  };
}
