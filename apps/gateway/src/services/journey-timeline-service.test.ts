import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GovernanceJourneyEventRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  JourneyTimelineService,
  decodeJourneyTimelineCursor,
  encodeJourneyTimelineCursor,
} from "./journey-timeline-service.js";

const created: Array<{ root: string; storage: Storage }> = [];
const FINGERPRINT = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    created.splice(0).map(async ({ root, storage }) => {
      storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("JourneyTimelineService HX-402", () => {
  it("returns a stable read-only timeline with source, approval, and cursor evidence", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-older",
        idempotencyKey: "journey:older",
        action: "memory_item_forgotten",
        eventType: "memory_lifecycle",
        subjectKind: "memory_item",
        subjectId: "memory-1",
        fingerprint: "b".repeat(64),
        approvalId: "approval-1",
        evidenceRefs: [
          { owner: "approval", refId: "approval-1" },
          { owner: "memory_history", refId: "change-1" },
        ],
        sourceKind: "memory_history",
        sourceId: "change-1",
        occurredAt: "2026-07-13T01:00:00.000Z",
        recordedAt: "2026-07-13T01:00:00.000Z",
      }),
    );
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-newer",
        idempotencyKey: "journey:newer",
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );

    const first = await service.listTimeline({ workspaceId: "workspace-1", limit: 1 });
    expect(first).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-1",
      items: [
        {
          eventId: "event-newer",
          category: "skill_learning",
          evidence: { health: "missing_approval", trustContribution: "blocked" },
        },
      ],
    });
    expect(first.items[0]?.eventFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.nextCursor).toBeTruthy();

    const second = await service.listTimeline({ workspaceId: "workspace-1", limit: 1, cursor: first.nextCursor });
    expect(second.items).toMatchObject([
      {
        eventId: "event-older",
        category: "memory",
        evidence: {
          health: "complete",
          sourceLinked: true,
          approvalLinked: true,
          trustContribution: "evidence_only",
        },
      },
    ]);
    expect(second.nextCursor).toBeUndefined();

    const replay = await service.listTimeline({ workspaceId: "workspace-1", limit: 1 });
    expect(replay.items[0]?.eventFingerprint).toBe(first.items[0]?.eventFingerprint);
  });

  it("distinguishes distinct-session recurrence from repeated evidence in one session", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      approvedEvent({
        eventId: "event-a",
        idempotencyKey: "journey:a",
        sessionId: "session-1",
        sourceId: "evidence-a",
      }),
    );
    storage.governanceJourneyEvents.create(
      approvedEvent({
        eventId: "event-a-proposal",
        idempotencyKey: "journey:a:proposal",
        sessionId: "session-1",
        sourceId: "evidence-a",
        eventType: "capability_proposal_lifecycle",
        action: "proposal_created",
        subjectKind: "capability_proposal",
      }),
    );
    storage.governanceJourneyEvents.create(
      approvedEvent({
        eventId: "event-b",
        idempotencyKey: "journey:b",
        sessionId: "session-1",
        sourceId: "evidence-b",
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );
    storage.governanceJourneyEvents.create(
      approvedEvent({
        eventId: "event-c",
        idempotencyKey: "journey:c",
        sessionId: "session-2",
        sourceId: "evidence-c",
        occurredAt: "2026-07-13T03:00:00.000Z",
        recordedAt: "2026-07-13T03:00:00.000Z",
      }),
    );

    const page = await service.listTimeline({ workspaceId: "workspace-1" });
    expect(page.items[0]?.recurrence).toEqual({
      evidenceFingerprint: FINGERPRINT,
      observationCount: 3,
      distinctSessionCount: 2,
      repeatedObservationCount: 1,
      blockedObservationCount: 0,
      complete: true,
    });
    expect(page.items[0]?.evidence.trustContribution).toBe("evidence_only");
  });

  it("does not accept candidate-only refs as source evidence or generic edits without approval", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-candidate-only",
        idempotencyKey: "journey:candidate-only",
        eventType: "candidate_skill_lifecycle",
        subjectKind: "candidate_skill_version",
        action: "candidate_created_inactive",
        sourceKind: undefined,
        sourceId: undefined,
        evidenceRefs: [{ owner: "candidate", refId: "candidate-1" }],
      }),
    );
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-edit",
        idempotencyKey: "journey:edit",
        eventType: "memory_lifecycle",
        subjectKind: "memory_item",
        action: "memory_item_updated",
        sourceKind: "memory_history",
        sourceId: "change-edit",
        evidenceRefs: [{ owner: "memory_history", refId: "change-edit" }],
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );

    const page = await service.listTimeline({ workspaceId: "workspace-1" });
    expect(page.items.find((item) => item.eventId === "event-candidate-only")?.evidence).toMatchObject({
      sourceLinked: false,
      approvalLinked: false,
      health: "missing_source_and_approval",
      trustContribution: "blocked",
    });
    expect(page.items.find((item) => item.eventId === "event-edit")?.evidence).toMatchObject({
      sourceLinked: true,
      approvalLinked: false,
      health: "missing_approval",
      trustContribution: "blocked",
    });
  });

  it("recognizes content-free external-source import references as source evidence", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-external-import",
        idempotencyKey: "journey:external-import",
        eventType: "external_session_import",
        subjectKind: "external_source_import",
        subjectId: "import-1",
        action: "imported_read_only",
        sourceKind: "external_source",
        sourceId: "source-1",
        trustDisposition: "read_only_external",
        evidenceRefs: [{ owner: "external_source", refId: "import-1" }],
        provenance: {
          sourceRequired: true,
          approvalRequired: false,
          sourceWorkspaceId: "workspace-1",
        },
      }),
    );

    const item = (await service.listTimeline({ workspaceId: "workspace-1" })).items[0];
    expect(item?.category).toBe("provenance");
    expect(item?.evidence).toMatchObject({
      sourceLinked: true,
      approvalLinked: false,
      health: "complete",
      trustContribution: "evidence_only",
    });
  });

  it("marks recurrence scans incomplete when more than 500 canonical observations exist", async () => {
    const { storage, service } = await createHarness();
    for (let index = 0; index < 501; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString();
      storage.governanceJourneyEvents.create(
        approvedEvent({
          eventId: `event-bounded-${String(index).padStart(3, "0")}`,
          idempotencyKey: `journey:bounded:${index}`,
          sessionId: `session-${index}`,
          sourceId: `evidence-${index}`,
          occurredAt: timestamp,
          recordedAt: timestamp,
        }),
      );
    }
    const page = await service.listTimeline({ workspaceId: "workspace-1", limit: 1 });
    expect(page.items[0]?.recurrence).toMatchObject({
      observationCount: 500,
      distinctSessionCount: 500,
      complete: false,
    });
    expect(page.items[0]?.evidence.trustContribution).toBe("blocked");
  });

  it("keeps poisoned, conflicting, and foreign-scope evidence visible but unable to contribute trust", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-conflict",
        idempotencyKey: "journey:conflict",
        sourceId: "evidence-conflict",
        poisoningStatus: "conflicting",
        summary: { blockerCodes: ["CONFLICTING_FINGERPRINT"] },
      }),
    );
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-foreign",
        idempotencyKey: "journey:foreign",
        sourceId: "evidence-foreign",
        provenance: { sourceWorkspaceId: "workspace-foreign" },
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );

    const page = await service.listTimeline({ workspaceId: "workspace-1" });
    expect(page.items.map((item) => [item.eventId, item.evidence.health, item.evidence.trustContribution])).toEqual([
      ["event-foreign", "foreign_scope", "blocked"],
      ["event-conflict", "conflicting", "blocked"],
    ]);
    expect(page.items[0]?.recurrence).toMatchObject({
      distinctSessionCount: 0,
      blockedObservationCount: 2,
    });
  });

  it("includes global evidence only when requested and blocks global evidence that claims a foreign source scope", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-global-clean",
        idempotencyKey: "journey:global-clean",
        scopeKind: "global",
        workspaceId: undefined,
        action: "evidence_observed",
        provenance: { sourceRequired: false, approvalRequired: false },
      }),
    );
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-global-foreign",
        idempotencyKey: "journey:global-foreign",
        scopeKind: "global",
        workspaceId: undefined,
        sourceId: "foreign-evidence",
        provenance: { sourceWorkspaceId: "workspace-foreign" },
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );

    expect((await service.listTimeline({ workspaceId: "workspace-1" })).items).toEqual([]);
    const included = await service.listTimeline({ workspaceId: "workspace-1", includeGlobal: true });
    expect(included.items.map((item) => [item.eventId, item.evidence.health])).toEqual([
      ["event-global-foreign", "foreign_scope"],
      ["event-global-clean", "complete"],
    ]);
  });

  it("fails closed when a canonical event does not declare source and approval requirements", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(
      event({
        provenance: { correctionActionId: "legacy-correction" },
        approvalId: "approval-1",
        evidenceRefs: [
          { owner: "approval", refId: "approval-1" },
          { owner: "artifact", refId: "artifact-1" },
        ],
      }),
    );

    expect((await service.listTimeline({ workspaceId: "workspace-1" })).items[0]?.evidence).toMatchObject({
      health: "requirements_undeclared",
      requirementsDeclared: false,
      requiresSource: true,
      requiresApproval: true,
      trustContribution: "blocked",
    });
  });

  it("binds opaque cursors to the exact workspace and filter set", async () => {
    const { storage, service } = await createHarness();
    storage.governanceJourneyEvents.create(event());
    storage.governanceJourneyEvents.create(
      event({
        eventId: "event-2",
        idempotencyKey: "journey:2",
        occurredAt: "2026-07-13T02:00:00.000Z",
        recordedAt: "2026-07-13T02:00:00.000Z",
      }),
    );
    const first = await service.listTimeline({ workspaceId: "workspace-1", limit: 1 });
    await expect(
      service.listTimeline({ workspaceId: "workspace-2", limit: 1, cursor: first.nextCursor }),
    ).rejects.toThrow(/does not match/u);
    await expect(
      service.listTimeline({
        workspaceId: "workspace-1",
        limit: 1,
        eventTypes: ["memory_lifecycle"],
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/does not match/u);
    expect(() => decodeJourneyTimelineCursor("not-canonical+base64")).toThrow(/malformed/u);
  });

  it("round-trips canonical cursor bytes", () => {
    const cursor = {
      version: "goatcitadel.journey-cursor.v1" as const,
      workspaceId: "workspace-1",
      includeGlobal: false,
      filterHash: "b".repeat(64),
      highWater: { recordedAt: "2026-07-13T02:00:00.000Z", eventId: "event-2" },
      position: { recordedAt: "2026-07-13T01:00:00.000Z", eventId: "event-1" },
    };
    expect(decodeJourneyTimelineCursor(encodeJourneyTimelineCursor(cursor))).toEqual(cursor);
  });
});

async function createHarness(): Promise<{ storage: Storage; service: JourneyTimelineService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-hx402-journey-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  created.push({ root, storage });
  return {
    storage,
    service: new JourneyTimelineService(createSqliteAsyncStorage(storage).governanceJourneyEvents),
  };
}

function event(overrides: Partial<GovernanceJourneyEventRecord> = {}): GovernanceJourneyEventRecord {
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: "event-1",
    idempotencyKey: "journey:1",
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    eventType: "skill_learning_evidence_assessed",
    subjectKind: "skill_learning_evidence",
    subjectId: "evidence-1",
    action: "correction_recorded",
    actorId: "operator-1",
    actorType: "operator",
    sessionId: "session-1",
    turnId: "turn-1",
    fingerprint: FINGERPRINT,
    sourceKind: "skill_learning_evidence",
    sourceId: "evidence-1",
    trustDisposition: "review_only",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "artifact", refId: "artifact-1" }],
    provenance: { correctionActionId: "correction-1", sourceRequired: true, approvalRequired: true },
    summary: { callable: false, directPromotion: false, memoryMutation: false },
    occurredAt: "2026-07-13T01:00:00.000Z",
    recordedAt: "2026-07-13T01:00:00.000Z",
    ...overrides,
  };
}

function approvedEvent(overrides: Partial<GovernanceJourneyEventRecord> = {}): GovernanceJourneyEventRecord {
  return event({
    approvalId: "approval-1",
    evidenceRefs: [
      { owner: "approval", refId: "approval-1" },
      { owner: "artifact", refId: "artifact-1" },
    ],
    ...overrides,
  });
}
