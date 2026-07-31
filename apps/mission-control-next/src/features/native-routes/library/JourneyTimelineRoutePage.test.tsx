import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyTimelineItem } from "@goatcitadel/contracts";
import {
  JourneyTimelineRoutePage,
  eventTypesForJourneyCategory,
  formatJourneyEvidenceHealth,
  mergeJourneyItems,
  semanticRecordRows,
} from "./JourneyTimelineRoutePage";

const api = vi.hoisted(() => ({ fetchJourneyTimeline: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared", () => ({ fetchJourneyTimeline: api.fetchJourneyTimeline }));

const baseItem: JourneyTimelineItem = {
  eventId: "event-1",
  eventFingerprint: "a".repeat(64),
  evidenceFingerprint: "b".repeat(64),
  category: "skill_learning",
  scopeKind: "workspace",
  workspaceId: "workspace-1",
  eventType: "skill_learning_evidence_assessed",
  subjectKind: "skill_learning_evidence",
  subjectId: "evidence-1",
  action: "correction_recorded",
  actorId: "operator-1",
  actorType: "operator",
  sessionId: "session-1",
  sourceKind: "skill_learning_evidence",
  sourceId: "evidence-1",
  poisoningStatus: "conflicting",
  evidenceRefs: [{ owner: "artifact", refId: "artifact-1" }],
  evidence: {
    health: "conflicting",
    sourceLinked: true,
    approvalLinked: false,
    requiresSource: true,
    requiresApproval: true,
    requirementsDeclared: true,
    trustContribution: "blocked",
    blockerCodes: ["CONFLICTING_FINGERPRINT"],
  },
  recurrence: {
    evidenceFingerprint: "b".repeat(64),
    observationCount: 2,
    distinctSessionCount: 1,
    repeatedObservationCount: 1,
    blockedObservationCount: 1,
    complete: true,
  },
  provenance: { correctionActionId: "correction-1" },
  summary: { directPromotion: false },
  occurredAt: "2026-07-13T01:00:00.000Z",
  recordedAt: "2026-07-13T01:00:00.000Z",
};

describe("JourneyTimelineRoutePage HX-402", () => {
  beforeEach(() => {
    api.fetchJourneyTimeline.mockReset();
    api.fetchJourneyTimeline.mockResolvedValue({
      schemaVersion: "goatcitadel.journey-timeline-page.v1",
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-1",
      includeGlobal: false,
      items: [baseItem],
      generatedAt: "2026-07-13T02:00:00.000Z",
    });
  });

  it("renders inspectable blocked evidence with no mutation controls", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <JourneyTimelineRoutePage
          route={{ area: "library", section: "journey" as never }}
          activeWorkspaceId="workspace-1"
          activeWorkspaceName="Workspace One"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Journey timeline");
    expect(text).toContain('"data-release-status":"experimental"');
    expect(text).toContain("conflicting");
    expect(text).toContain("Stable event fingerprint");
    expect(text).toContain("Experimental read-only boundary");
    expect(text).toContain("captured skill learning, approvals, effects, and Skills Hub lifecycle evidence");
    expect(text).toContain("must not be used as release-bearing parity evidence");
    expect(text).toContain("Required, missing");
    expect(text).not.toContain("Promote now");
    expect(text).not.toContain("Activate now");
    const regionNames = renderer!.root
      .findAll((node) => node.props?.role === "region")
      .map((node) =>
        String(node.props["aria-label"] ?? "")
          .trim()
          .replace(/\s+/g, " "),
      )
      .filter(Boolean);
    expect(regionNames).toEqual(
      expect.arrayContaining(["Evidence references entries", "Provenance entries", "Event summary entries"]),
    );
    expect(new Set(regionNames.map((name) => name.toLocaleLowerCase("en-US"))).size).toBe(regionNames.length);
    expect(api.fetchJourneyTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", limit: 50 }),
    );
  });

  it("retains its Experimental scope badge when route data fails", async () => {
    api.fetchJourneyTimeline.mockRejectedValueOnce(new Error("fixture unavailable"));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <JourneyTimelineRoutePage
          route={{ area: "library", section: "journey" as never }}
          activeWorkspaceId="workspace-1"
          activeWorkspaceName="Workspace One"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain('"data-release-status":"experimental"');
    expect(text).toContain("This section could not load");
    expect(text).toContain("fixture unavailable");
  });

  it("maps bounded event-family filters and formats evidence status", () => {
    expect(eventTypesForJourneyCategory("memory")).toContain("memory_lifecycle");
    expect(eventTypesForJourneyCategory("skills")).toEqual(
      expect.arrayContaining(["skill_hub_review", "skill_hub_lifecycle"]),
    );
    expect(eventTypesForJourneyCategory("imports")).toEqual(
      expect.arrayContaining(["skill_hub_review", "skill_hub_lifecycle"]),
    );
    expect(eventTypesForJourneyCategory("approvals")).toEqual(
      expect.arrayContaining(["approval_lifecycle", "approval_effect_lifecycle"]),
    );
    expect(eventTypesForJourneyCategory("provenance")).not.toContain("skill_upstream_snapshot");
    expect(eventTypesForJourneyCategory("all")).toBeUndefined();
    expect(formatJourneyEvidenceHealth("missing_source_and_approval")).toBe("missing source and approval");
    expect(semanticRecordRows({ correctionActionId: "correction-1", nested: { hidden: true } })).toEqual([
      ["correctionActionId", "correction-1"],
      ["nested", "Structured evidence recorded"],
    ]);
  });

  it("merges cursor pages without duplicate events and preserves descending order", () => {
    const newer = { ...baseItem, eventId: "event-2", recordedAt: "2026-07-13T02:00:00.000Z" };
    const replay = { ...baseItem, summary: { replayed: true } };
    expect(mergeJourneyItems([baseItem], [newer, replay]).map((item) => item.eventId)).toEqual(["event-2", "event-1"]);
    expect(mergeJourneyItems([baseItem], [replay]).find((item) => item.eventId === "event-1")?.summary).toEqual({
      replayed: true,
    });
  });
});
