import type { ApprovalRequest, RealtimeEvent } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { composeCitadelBrief, type CitadelBriefInput } from "./citadel-brief.js";

const GENERATED_AT = "2026-08-16T18:00:00.000Z";
const SINCE = "2026-08-15T18:00:00.000Z";

function approval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    approvalId: "appr-1",
    kind: "tool.invoke",
    riskLevel: "caution",
    status: "pending",
    payload: { secretish: "never-surfaced" },
    preview: { alsoNever: "surfaced" },
    createdAt: "2026-08-16T06:00:00.000Z",
    explanationStatus: "none",
    ...overrides,
  } as ApprovalRequest;
}

function event(overrides: Partial<RealtimeEvent>): RealtimeEvent {
  return {
    eventId: "evt-1",
    sequence: 1,
    eventType: "session.updated",
    source: "gateway",
    timestamp: "2026-08-16T12:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function baseInput(overrides: Partial<CitadelBriefInput> = {}): CitadelBriefInput {
  return {
    citadelId: "personal",
    citadelName: "Personal",
    since: SINCE,
    generatedAt: GENERATED_AT,
    workspaces: [{ workspaceId: "ws-1", name: "Default" }],
    pendingApprovalsByWorkspace: [],
    events: [],
    costSummaries: [],
    memory: { recommendations: [] },
    ...overrides,
  };
}

describe("composeCitadelBrief", () => {
  it("projects pending approvals to safe scalars with age, oldest first", () => {
    const brief = composeCitadelBrief(
      baseInput({
        pendingApprovalsByWorkspace: [
          {
            workspaceId: "ws-1",
            items: [
              approval({ approvalId: "young", createdAt: "2026-08-16T17:00:00.000Z" }),
              approval({ approvalId: "old", createdAt: "2026-08-16T04:00:00.000Z", riskLevel: "danger" }),
              approval({ approvalId: "resolved", status: "approved" }),
            ],
          },
        ],
      }),
    );

    expect(brief.approvals.pendingCount).toBe(2);
    expect(brief.approvals.pending.map((item) => item.approvalId)).toEqual(["old", "young"]);
    expect(brief.approvals.oldestAgeMs).toBe(14 * 60 * 60 * 1000);
    expect(brief.approvals.pending[0]).not.toHaveProperty("payload");
    expect(brief.approvals.pending[0]).not.toHaveProperty("preview");
    expect(JSON.stringify(brief)).not.toContain("never-surfaced");
  });

  it("windows events to [since, generatedAt] and classifies completion, failure, and ward hits", () => {
    const brief = composeCitadelBrief(
      baseInput({
        events: [
          event({ eventId: "in-1", eventType: "durable_run.completed", timestamp: "2026-08-16T10:00:00.000Z" }),
          event({ eventId: "in-2", eventType: "hook.delivery.failed", timestamp: "2026-08-16T11:00:00.000Z" }),
          event({ eventId: "in-3", eventType: "citadel_ward.matched", timestamp: "2026-08-16T12:00:00.000Z" }),
          event({ eventId: "in-4", eventType: "session.updated", timestamp: "2026-08-16T13:00:00.000Z" }),
          event({
            eventId: "before-window",
            eventType: "durable_run.completed",
            timestamp: "2026-08-14T10:00:00.000Z",
          }),
          event({ eventId: "after-window", eventType: "durable_run.failed", timestamp: "2026-08-16T19:00:00.000Z" }),
        ],
      }),
    );

    expect(brief.activity.eventsSince).toBe(4);
    expect(brief.activity.completedSince).toBe(1);
    expect(brief.activity.failedSince).toBe(1);
    expect(brief.activity.wardHitsSince).toBe(1);
    expect(brief.activity.byType[0]).toEqual({ eventType: "citadel_ward.matched", count: 1 });
  });

  it("sums spend slices and clears the completeness flag when any slice is partial", () => {
    const brief = composeCitadelBrief(
      baseInput({
        costSummaries: [
          { key: "2026-08-16", costUsd: 1.25, tokenTotal: 4000, metricAvailability: { costUsdComplete: true } },
          { key: "2026-08-15", costUsd: 0.5, tokenTotal: 1000, metricAvailability: { costUsdComplete: false } },
        ],
      }),
    );

    expect(brief.spend).toEqual({ scope: "instance", sinceUsd: 1.75, sinceTokens: 5000, complete: false });
  });

  it("counts pending memory recommendations and passes through unavailability", () => {
    const withRecommendations = composeCitadelBrief(
      baseInput({
        memory: { recommendations: [{ status: "pending" }, { status: "accepted" }, {}] },
      }),
    );
    expect(withRecommendations.memory).toEqual({ pendingRecommendations: 2 });

    const unavailable = composeCitadelBrief(baseInput({ memory: { unavailable: "feature disabled" } }));
    expect(unavailable.memory).toEqual({ unavailable: "feature disabled" });
  });
});
