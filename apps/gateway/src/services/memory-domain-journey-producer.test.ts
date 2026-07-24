import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { buildMemoryLifecycleApprovalBinding } from "./memory-journey-producer.js";
import {
  buildMemoryLifecycleApprovalPayload,
  buildStructuredMemoryJourneyEvent,
  createMemoryGovernedLifecycleRepository,
  deriveMemoryLifecycleApprovalId,
  isMemoryMaintenanceSystemAuthority,
  MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID,
  MemoryLifecycleApplyError,
  mintMemoryMaintenanceSystemAuthority,
  parseMemoryLifecycleRequestEnvelope,
  persistMemorySystemExpiryEvidence,
} from "./memory-domain-journey-producer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createStorage(): Storage {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  return storage;
}

describe("memory domain governed lifecycle producer", () => {
  it("derives one deterministic payload-hash UUID per exact request AND exact reviewed state", () => {
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-a",
      subjectKind: "memory_item",
      subjectId: "item-1",
      action: "item_updated",
      mutation: { title: "New title" },
      expectedState: { itemsSha256: "a".repeat(64) },
    });
    const approvalId = deriveMemoryLifecycleApprovalId(binding);
    expect(approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveMemoryLifecycleApprovalId(binding)).toBe(approvalId);
    // A different reviewed state is a DIFFERENT approval identity.
    const driftedState = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-a",
      subjectKind: "memory_item",
      subjectId: "item-1",
      action: "item_updated",
      mutation: { title: "New title" },
      expectedState: { itemsSha256: "b".repeat(64) },
    });
    expect(deriveMemoryLifecycleApprovalId(driftedState)).not.toBe(approvalId);
    // A different mutation is a DIFFERENT approval identity.
    const driftedMutation = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-a",
      subjectKind: "memory_item",
      subjectId: "item-1",
      action: "item_updated",
      mutation: { title: "Other title" },
      expectedState: { itemsSha256: "a".repeat(64) },
    });
    expect(deriveMemoryLifecycleApprovalId(driftedMutation)).not.toBe(approvalId);
  });

  it("same approval identity with different payload material conflicts in the approvals owner", () => {
    const storage = createStorage();
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-a",
      subjectKind: "memory_item",
      subjectId: "item-1",
      action: "item_updated",
      mutation: { title: "New title" },
      expectedState: { itemsSha256: "a".repeat(64) },
    });
    const approvalId = deriveMemoryLifecycleApprovalId(binding);
    const create = (requesterId: string) =>
      storage.approvals.createDeterministicDetachedWithTtlDuration(
        {
          approvalId,
          kind: "memory.lifecycle",
          riskLevel: "danger",
          payload: buildMemoryLifecycleApprovalPayload({ binding, requesterId, mutation: { title: "New title" } }),
          preview: { title: "Memory approval" },
          linkage: { workspaceId: "workspace-a" },
        },
        60_000,
      );
    const first = create("operator-one");
    expect(first.created).toBe(true);
    // Byte-exact replay converges on the original approval row.
    const replay = create("operator-one");
    expect(replay.created).toBe(false);
    expect(replay.approval.approvalId).toBe(approvalId);
    // Same identity, different material (a different requester) conflicts.
    expect(() => create("operator-two")).toThrow();
  });

  it("round-trips the immutable request envelope and rejects malformed payload shapes", () => {
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-a",
      subjectKind: "memory_item_batch",
      action: "items_forgotten",
      mutation: { actionId: "forget-1", itemIds: ["a", "b"] },
      expectedState: { itemsSha256: "c".repeat(64) },
    });
    const payload = buildMemoryLifecycleApprovalPayload({
      binding,
      requesterId: "operator-one",
      mutation: { actionId: "forget-1", itemIds: ["a", "b"] },
    });
    expect(parseMemoryLifecycleRequestEnvelope(payload)).toMatchObject({
      requesterId: "operator-one",
      mutation: { actionId: "forget-1", itemIds: ["a", "b"] },
    });
    expect(parseMemoryLifecycleRequestEnvelope({})).toBeUndefined();
    expect(parseMemoryLifecycleRequestEnvelope({ request: { requesterId: "x" } })).toBeUndefined();
    expect(
      parseMemoryLifecycleRequestEnvelope({
        request: { schemaVersion: "wrong", requesterId: "x", mutation: {} },
      }),
    ).toBeUndefined();
    expect(
      parseMemoryLifecycleRequestEnvelope({
        request: {
          schemaVersion: "goatcitadel.memory-lifecycle-request-envelope.v1",
          requesterId: "x",
          mutation: {},
          extra: 1,
        },
      }),
    ).toBeUndefined();
  });

  it("mints an unforgeable module-private system maintenance authority (brand test)", () => {
    const authority = mintMemoryMaintenanceSystemAuthority();
    expect(authority.actorId).toBe(MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID);
    expect(isMemoryMaintenanceSystemAuthority(authority)).toBe(true);

    // Route inputs can never mint one: JSON round-trips throw, and structural
    // copies (spread, structuredClone-alikes, handwritten objects) fail the
    // module-private WeakSet membership check.
    expect(() => JSON.stringify(authority)).toThrow(ConflictError);
    expect(isMemoryMaintenanceSystemAuthority({ actorId: MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID })).toBe(false);
    expect(isMemoryMaintenanceSystemAuthority({ ...authority })).toBe(false);
    expect(
      isMemoryMaintenanceSystemAuthority(
        Object.assign(Object.create(Object.getPrototypeOf(authority) as object), { actorId: authority.actorId }),
      ),
    ).toBe(false);
    expect(isMemoryMaintenanceSystemAuthority(undefined)).toBe(false);
    expect(isMemoryMaintenanceSystemAuthority("system:memory-maintenance")).toBe(false);
  });

  it("writes system expiry evidence only for the branded authority and keeps it immutable in the P0 owner", () => {
    const storage = createStorage();
    const repository = createMemoryGovernedLifecycleRepository(storage.gatewaySql);
    const change = {
      changeId: "change-expiry-1",
      itemId: "item-expiry-1",
      changeType: "forgotten" as const,
      actorId: MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID,
      payload: { previousStatus: "active" },
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const item = {
      itemId: "item-expiry-1",
      workspaceId: "workspace-a",
      lifecycleState: "forgotten",
      expiresAt: "2026-07-19T00:00:00.000Z",
    };

    const forged = { actorId: MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID } as never;
    expect(() =>
      persistMemorySystemExpiryEvidence(repository, {
        authority: forged,
        change,
        item,
        occurredAt: change.createdAt,
      }),
    ).toThrow(/module-private system authority/i);

    const authority = mintMemoryMaintenanceSystemAuthority();
    const evidence = persistMemorySystemExpiryEvidence(repository, {
      authority,
      change,
      item,
      occurredAt: change.createdAt,
    });
    expect(evidence.event).toMatchObject({
      domain: "memory",
      operation: "maintenance_expired",
      targetKind: "memory_item",
      targetId: "item-expiry-1",
      actorType: "system",
      actorId: MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID,
      sourceKind: "memory_change_history",
      sourceId: "change-expiry-1",
      approvalRequired: false,
    });
    expect(evidence.journeyEvent).toMatchObject({
      eventType: "memory_item_lifecycle",
      action: "maintenance_expired",
      actorType: "system",
      trustDisposition: "system_memory_maintenance",
    });
    // Exact replay converges byte-identically.
    const replay = persistMemorySystemExpiryEvidence(repository, {
      authority,
      change,
      item,
      occurredAt: change.createdAt,
    });
    expect(replay.event).toEqual(evidence.event);
    // The P0 owner is trigger-immutable in this dialect.
    expect(() =>
      storage.gatewaySql
        .prepare("UPDATE governed_lifecycle_events SET actor_id = 'forged' WHERE event_id = @eventId")
        .run({ eventId: evidence.event.eventId }),
    ).toThrow();
    expect(() =>
      storage.gatewaySql
        .prepare("DELETE FROM governed_lifecycle_events WHERE event_id = @eventId")
        .run({ eventId: evidence.event.eventId }),
    ).toThrow();
    // Global-scope expiry (no workspace) stays writable under system authority.
    const globalEvidence = persistMemorySystemExpiryEvidence(repository, {
      authority,
      change: { ...change, changeId: "change-expiry-global", itemId: "item-expiry-global" },
      item: { ...item, itemId: "item-expiry-global", workspaceId: undefined },
      occurredAt: change.createdAt,
    });
    expect(globalEvidence.event).toMatchObject({ scopeKind: "global" });
  });

  it("fails closed when the SQL host cannot provide immediate transactions", () => {
    expect(() =>
      createMemoryGovernedLifecycleRepository({
        dialect: "sqlite",
        prepare: () => {
          throw new Error("unused");
        },
      }),
    ).toThrow(/transactional gateway storage/i);
  });

  it("builds structured Journey evidence with explicit review-only provenance", () => {
    const event = buildStructuredMemoryJourneyEvent({
      recordKind: "decision",
      recordId: "decision-1",
      changeId: "structured-change-1",
      changeType: "retrospective_added",
      actorId: "operator-one",
      workspaceId: "workspace-a",
      occurredAt: "2026-07-20T00:00:00.000Z",
      correctionRefId: "improvement-candidate-9",
    });
    expect(event).toMatchObject({
      eventType: "memory_structured_lifecycle",
      subjectKind: "memory_decision",
      subjectId: "decision-1",
      action: "retrospective_added",
      sourceKind: "memory_structured_change_history",
      sourceId: "structured-change-1",
      provenance: {
        sourceRequired: true,
        approvalRequired: false,
        correctionProvenance: "explicit",
        correctionRefId: "improvement-candidate-9",
      },
      summary: {
        memoryMutationObserved: true,
        journeyMutationAuthority: false,
        callable: false,
        directPromotion: false,
      },
    });
  });

  it("exposes a content-free terminal error taxonomy for the recovered effect", () => {
    const error = new MemoryLifecycleApplyError("memory_lifecycle_request_drift");
    expect(error.code).toBe("memory_lifecycle_request_drift");
    expect(error.name).toBe("MemoryLifecycleApplyError");
    expect(error.message).not.toMatch(/title|content|metadata/i);
  });
});
