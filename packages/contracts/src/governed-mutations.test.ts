import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApprovalEffectKind, ApprovalEffectTargetKind } from "./approvals.js";
import type { GovernanceJourneyEvidenceRef } from "./journey.js";
import {
  CAPABILITY_LIFECYCLE_APPROVAL_KIND,
  CAPABILITY_LIFECYCLE_EFFECT_KIND,
  CAPABILITY_LIFECYCLE_EFFECT_TARGET_KIND,
  GOVERNED_LIFECYCLE_EVENT_VERSION,
  GOVERNED_MUTATION_KINDS,
  GOVERNED_MUTATION_MATERIAL_VERSION,
  IMPROVEMENT_LIFECYCLE_APPROVAL_KIND,
  IMPROVEMENT_LIFECYCLE_EFFECT_KIND,
  IMPROVEMENT_LIFECYCLE_EFFECT_TARGET_KIND,
  MEMORY_LIFECYCLE_APPROVAL_KIND,
  MEMORY_LIFECYCLE_EFFECT_KIND,
  MEMORY_LIFECYCLE_EFFECT_TARGET_KIND,
  SKILL_LIFECYCLE_APPROVAL_KIND,
  SKILL_LIFECYCLE_EFFECT_KIND,
  SKILL_LIFECYCLE_EFFECT_TARGET_KIND,
  assertGovernedLifecycleEventRecord,
  computeGovernedMutationMaterialSha256,
  computeImprovementLifecycleRequestSha256,
  computeImprovementLifecycleResultSha256,
  findGovernedMutationKind,
  governedMutationKind,
  isGovernedLifecycleEventRecord,
  isImprovementLifecycleInspectionDisposition,
  isImprovementLifecycleOperationKind,
  isImprovementLifecycleSettlementDisposition,
  isImprovementLifecycleTargetKind,
  type GovernedLifecycleEventRecord,
} from "./governed-mutations.js";
import { canonicalJsonString } from "./canonical-json.js";
import { createHash } from "node:crypto";

const SHA_A = "a".repeat(64);

function approvedEvent(overrides: Partial<GovernedLifecycleEventRecord> = {}): GovernedLifecycleEventRecord {
  return {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId: "governed-event-1",
    idempotencyKey: "memory:item_updated:item-1:change-1",
    domain: "memory",
    operation: "item_updated",
    targetKind: "memory_item",
    targetId: "item-1",
    materialSha256: SHA_A,
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    actorId: "operator-1",
    actorType: "operator",
    sessionId: "session-1",
    turnId: "turn-1",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: "memory_history",
    sourceId: "change-1",
    approvalId: "approval-1",
    occurredAt: "2026-07-23T12:00:00.000Z",
    recordedAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("governed mutation kind registry", () => {
  it("freezes 32 kinds across the four governed domains", () => {
    expect(GOVERNED_MUTATION_KINDS).toHaveLength(32);
    const byDomain = new Map<string, number>();
    for (const declaration of GOVERNED_MUTATION_KINDS) {
      byDomain.set(declaration.domain, (byDomain.get(declaration.domain) ?? 0) + 1);
    }
    expect(Object.fromEntries(byDomain)).toEqual({
      memory: 17,
      skill_state: 6,
      capability_state: 5,
      improvement: 4,
    });
  });

  it("declares both requirement booleans explicitly on every kind", () => {
    for (const declaration of GOVERNED_MUTATION_KINDS) {
      expect(typeof declaration.sourceRequired).toBe("boolean");
      expect(typeof declaration.approvalRequired).toBe("boolean");
      expect(typeof declaration.systemActorOnly).toBe("boolean");
      expect(declaration.sourceRequired).toBe(true);
    }
  });

  it("keeps every approval-free kind either system-only or the review-only proposal staging kind", () => {
    const approvalFree = GOVERNED_MUTATION_KINDS.filter((declaration) => !declaration.approvalRequired);
    expect(approvalFree.map((declaration) => `${declaration.domain}:${declaration.operation}`).sort()).toEqual([
      "capability_state:proposal_created",
      "capability_state:system_revoked",
      "memory:maintenance_expired",
      "skill_state:system_disabled",
    ]);
    for (const declaration of approvalFree) {
      if (declaration.operation !== "proposal_created") expect(declaration.systemActorOnly).toBe(true);
    }
  });

  it("fails closed on unknown kinds instead of inferring from names", () => {
    expect(() => governedMutationKind("memory", "item_promoted")).toThrow(/not in the frozen registry/u);
    expect(() => governedMutationKind("journey", "item_updated")).toThrow(/not in the frozen registry/u);
    expect(findGovernedMutationKind("memory", "item_promoted")).toBeUndefined();
    expect(findGovernedMutationKind("memory", "item_updated")?.targetKind).toBe("memory_item");
  });

  it("registry declarations are deeply frozen", () => {
    const declaration = governedMutationKind("memory", "item_updated");
    expect(Object.isFrozen(GOVERNED_MUTATION_KINDS)).toBe(true);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(() => {
      (declaration as { approvalRequired: boolean }).approvalRequired = false;
    }).toThrow(TypeError);
  });
});

describe("computeGovernedMutationMaterialSha256", () => {
  it("hashes versioned canonical material deterministically", () => {
    const material = { changeId: "change-1", itemSha256: SHA_A };
    const expected = createHash("sha256")
      .update(canonicalJsonString({ version: GOVERNED_MUTATION_MATERIAL_VERSION, material }), "utf8")
      .digest("hex");
    expect(computeGovernedMutationMaterialSha256(material)).toBe(expected);
    expect(computeGovernedMutationMaterialSha256({ itemSha256: SHA_A, changeId: "change-1" })).toBe(expected);
  });

  it("differs from an unversioned hash of the same material", () => {
    const material = { changeId: "change-1" };
    const unversioned = createHash("sha256").update(canonicalJsonString(material), "utf8").digest("hex");
    expect(computeGovernedMutationMaterialSha256(material)).not.toBe(unversioned);
  });

  it("rejects unbounded or non-object material", () => {
    expect(() => computeGovernedMutationMaterialSha256(null as unknown as Record<string, unknown>)).toThrow(TypeError);
    expect(() => computeGovernedMutationMaterialSha256({ blob: "x".repeat(40_000) })).toThrow(TypeError);
  });
});

describe("assertGovernedLifecycleEventRecord", () => {
  it("accepts a complete approval-bound event and its boolean twin", () => {
    const input = approvedEvent();
    expect(() => assertGovernedLifecycleEventRecord(input)).not.toThrow();
    expect(isGovernedLifecycleEventRecord(input)).toBe(true);
  });

  it("rejects declared requirements that diverge from the frozen registry", () => {
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ sourceRequired: false }))).toThrow(
      /must declare sourceRequired=true and approvalRequired=true exactly/u,
    );
    expect(() =>
      assertGovernedLifecycleEventRecord(
        approvedEvent({ approvalRequired: false, approvalId: undefined } as Partial<GovernedLifecycleEventRecord>),
      ),
    ).toThrow(/must declare sourceRequired=true and approvalRequired=true exactly/u);
  });

  it("requires the actual approval ID when approval is required and forbids it otherwise", () => {
    expect(() => assertGovernedLifecycleEventRecord({ ...approvedEvent(), approvalId: undefined })).toThrow(
      /approval ID is missing/u,
    );
    const systemExpiry = approvedEvent({
      domain: "memory",
      operation: "maintenance_expired",
      actorId: "system:memory-maintenance",
      actorType: "system",
      sourceRequired: true,
      approvalRequired: false,
    });
    expect(() => assertGovernedLifecycleEventRecord({ ...systemExpiry, approvalId: undefined })).not.toThrow();
    expect(() => assertGovernedLifecycleEventRecord(systemExpiry)).toThrow(/cannot carry an approval ID/u);
  });

  it("restricts fail-safe kinds to unforgeable system actors", () => {
    const forged = approvedEvent({
      domain: "skill_state",
      operation: "system_disabled",
      targetKind: "skill",
      sourceRequired: true,
      approvalRequired: false,
      approvalId: undefined,
      actorType: "operator",
    });
    expect(() => assertGovernedLifecycleEventRecord({ ...forged, approvalId: undefined })).toThrow(
      /requires unforgeable system actor authority/u,
    );
  });

  it("rejects target kinds that are not the kind's exact registered target", () => {
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ targetKind: "memory_batch" }))).toThrow(
      /targets memory_item, not memory_batch/u,
    );
  });

  it("never infers missing scope: workspace events need a workspace, global events forbid one", () => {
    expect(() => assertGovernedLifecycleEventRecord({ ...approvedEvent(), workspaceId: undefined })).toThrow(
      /workspace ID is missing/u,
    );
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ scopeKind: "global" }))).toThrow(
      /cannot claim a workspace ID/u,
    );
    const globalSkill = approvedEvent({
      domain: "skill_state",
      operation: "enabled",
      targetKind: "skill",
      scopeKind: "global",
      workspaceId: undefined,
      sourceKind: "skill_activation_event",
      sourceId: "event-1",
    });
    expect(isGovernedLifecycleEventRecord({ ...globalSkill, workspaceId: undefined })).toBe(true);
  });

  it("requires canonical source linkage when sourceRequired and keeps pairs together otherwise", () => {
    expect(() => assertGovernedLifecycleEventRecord({ ...approvedEvent(), sourceId: undefined })).toThrow(
      /source ID is missing/u,
    );
    const proposal = approvedEvent({
      domain: "capability_state",
      operation: "proposal_created",
      targetKind: "capability_proposal",
      approvalRequired: false,
      approvalId: undefined,
      sourceKind: "capability_proposal_event",
      sourceId: "proposal-event-1",
    });
    expect(isGovernedLifecycleEventRecord({ ...proposal, approvalId: undefined })).toBe(true);
  });

  it("rejects unknown keys, malformed hashes, orphan turn linkage, and non-canonical timestamps", () => {
    expect(() =>
      assertGovernedLifecycleEventRecord({ ...approvedEvent(), payload: { text: "raw" } } as unknown),
    ).toThrow(/unsupported key 'payload'/u);
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ materialSha256: "not-hex" }))).toThrow(
      /must be SHA-256 hex/u,
    );
    expect(() =>
      assertGovernedLifecycleEventRecord({ ...approvedEvent(), sessionId: undefined, turnId: "turn-1" }),
    ).toThrow(/turn linkage requires a session ID/u);
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ occurredAt: "2026-07-23 12:00:00" }))).toThrow(
      /canonical ISO timestamp/u,
    );
    expect(() => assertGovernedLifecycleEventRecord(approvedEvent({ eventId: " padded " }))).toThrow(
      /canonical identity form/u,
    );
  });
});

describe("governed lifecycle approval vocabulary", () => {
  it("pins the frozen approval kinds for the P1-P3 producers", () => {
    expect(MEMORY_LIFECYCLE_APPROVAL_KIND).toBe("memory.lifecycle");
    expect(SKILL_LIFECYCLE_APPROVAL_KIND).toBe("skill.lifecycle");
    expect(CAPABILITY_LIFECYCLE_APPROVAL_KIND).toBe("capability.lifecycle");
    expect(IMPROVEMENT_LIFECYCLE_APPROVAL_KIND).toBe("improvement.lifecycle");
  });

  it("admits the four lifecycle effect kinds and target kinds into the approval-effect unions", () => {
    const effectKinds: ApprovalEffectKind[] = [
      MEMORY_LIFECYCLE_EFFECT_KIND,
      SKILL_LIFECYCLE_EFFECT_KIND,
      CAPABILITY_LIFECYCLE_EFFECT_KIND,
      IMPROVEMENT_LIFECYCLE_EFFECT_KIND,
    ];
    const targetKinds: ApprovalEffectTargetKind[] = [
      MEMORY_LIFECYCLE_EFFECT_TARGET_KIND,
      SKILL_LIFECYCLE_EFFECT_TARGET_KIND,
      CAPABILITY_LIFECYCLE_EFFECT_TARGET_KIND,
      IMPROVEMENT_LIFECYCLE_EFFECT_TARGET_KIND,
    ];
    expect(effectKinds).toEqual([
      "memory_lifecycle_apply",
      "skill_lifecycle_apply",
      "capability_lifecycle_apply",
      "improvement_lifecycle_apply",
    ]);
    expect(targetKinds).toEqual(["memory_record", "skill_state", "capability_candidate", "improvement_operation"]);
  });

  it("admits the governed lifecycle and improvement operation Journey evidence owners", () => {
    expectTypeOf<"governed_lifecycle">().toExtend<GovernanceJourneyEvidenceRef["owner"]>();
    expectTypeOf<"improvement_operation">().toExtend<GovernanceJourneyEvidenceRef["owner"]>();
  });
});

describe("improvement lifecycle state machine contract", () => {
  it("bounds operation, target, inspection, and settlement vocabularies", () => {
    expect(isImprovementLifecycleOperationKind("activate")).toBe(true);
    expect(isImprovementLifecycleOperationKind("promote")).toBe(false);
    expect(isImprovementLifecycleTargetKind("improvement_activation")).toBe(true);
    expect(isImprovementLifecycleTargetKind("skill")).toBe(false);
    expect(isImprovementLifecycleInspectionDisposition("matches_intent")).toBe(true);
    expect(isImprovementLifecycleInspectionDisposition("applied")).toBe(false);
    expect(isImprovementLifecycleSettlementDisposition("applied")).toBe(true);
    expect(isImprovementLifecycleSettlementDisposition("matches_intent")).toBe(false);
  });

  it("hashes the exact intent request excluding only the generated approval linkage", () => {
    const request = {
      operationId: "improvement-op-1",
      idempotencyKey: "improvement:activate:activation-1",
      workspaceId: "workspace-1",
      operationKind: "activate" as const,
      targetKind: "improvement_activation" as const,
      targetId: "activation-1",
      actorId: "operator-1",
      sessionId: "session-1",
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const digest = computeImprovementLifecycleRequestSha256(request);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeImprovementLifecycleRequestSha256({ ...request })).toBe(digest);
    expect(computeImprovementLifecycleRequestSha256({ ...request, targetId: "activation-2" })).not.toBe(digest);
  });

  it("hashes bounded settlement results canonically and rejects oversized results", () => {
    const result = { disposition: "applied", observedStateSha256: SHA_A };
    expect(computeImprovementLifecycleResultSha256(result)).toBe(
      createHash("sha256").update(canonicalJsonString(result), "utf8").digest("hex"),
    );
    expect(() => computeImprovementLifecycleResultSha256({ blob: "x".repeat(40_000) })).toThrow(TypeError);
  });
});
