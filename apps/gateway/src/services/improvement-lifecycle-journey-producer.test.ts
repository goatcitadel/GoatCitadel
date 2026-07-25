import { describe, expect, it } from "vitest";
import { isGovernanceJourneyEventRecord } from "@goatcitadel/contracts";
import {
  buildImprovementLifecycleApprovalBinding,
  buildImprovementLifecycleApprovalPayload,
  buildImprovementLifecycleRequestJourneyEvent,
  buildImprovementLifecycleRequestSha256,
  buildImprovementLifecycleSettlementJourneyEvent,
  buildImprovementLifecycleStateSha256,
  computeImprovementLifecycleObservedStateSha256,
  createImprovementLifecycleOperationRepository,
  deriveImprovementLifecycleActivationId,
  deriveImprovementLifecycleApprovalId,
  deriveImprovementLifecycleInspectionId,
  deriveImprovementLifecycleOperationId,
  deriveImprovementLifecycleSettlementId,
  ImprovementLifecycleApplyError,
  improvementLifecycleOperationIdempotencyKey,
  improvementLifecycleRequestJourneyIdempotencyKey,
  parseImprovementActivateMutation,
  parseImprovementLifecycleApprovalBinding,
  parseImprovementLifecycleRequestEnvelope,
  parseImprovementPauseRollbackMutation,
} from "./improvement-lifecycle-journey-producer.js";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function pauseBinding() {
  return buildImprovementLifecycleApprovalBinding({
    workspaceId: "workspace-1",
    operationKind: "pause",
    targetKind: "improvement_activation",
    targetId: "activation-1",
    mutation: {
      activationId: "activation-1",
      preState: { hadValue: true, value: { strategy: "route_rebalance" } },
      targetState: { hadValue: false, value: null },
    },
    expectedState: { activation: { activationId: "activation-1", status: "active" } },
  });
}

describe("improvement lifecycle approval binding", () => {
  it("binds the exact request AND the exact reviewed state into one deterministic UUID approval identity", () => {
    const binding = pauseBinding();
    expect(binding.schemaVersion).toBe("goatcitadel.improvement-lifecycle-approval.v1");
    expect(binding.scopeKind).toBe("workspace");
    expect(binding.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.expectedStateSha256).toMatch(/^[a-f0-9]{64}$/u);

    const approvalId = deriveImprovementLifecycleApprovalId(binding);
    expect(approvalId).toMatch(UUID_PATTERN);
    // Byte-exact replay converges on the same identity.
    expect(deriveImprovementLifecycleApprovalId(pauseBinding())).toBe(approvalId);
    // The same mutation over drifted reviewed state is a DIFFERENT approval.
    expect(deriveImprovementLifecycleApprovalId({ ...binding, expectedStateSha256: "f".repeat(64) })).not.toBe(
      approvalId,
    );
    // A different operation kind over the same target is a different approval:
    // a pause approval can never be replayed as a rollback.
    const rollback = buildImprovementLifecycleApprovalBinding({
      workspaceId: "workspace-1",
      operationKind: "rollback",
      targetKind: "improvement_activation",
      targetId: "activation-1",
      mutation: {
        activationId: "activation-1",
        preState: { hadValue: true, value: { strategy: "route_rebalance" } },
        targetState: { hadValue: false, value: null },
      },
      expectedState: { activation: { activationId: "activation-1", status: "active" } },
    });
    expect(deriveImprovementLifecycleApprovalId(rollback)).not.toBe(approvalId);
  });

  it("round-trips the binding and request envelope through fail-closed parsers", () => {
    const binding = pauseBinding();
    const payload = buildImprovementLifecycleApprovalPayload({
      binding,
      requesterId: "operator-1",
      mutation: {
        activationId: "activation-1",
        preState: { hadValue: true, value: 1 },
        targetState: { hadValue: false, value: null },
      },
    });
    expect(parseImprovementLifecycleApprovalBinding(payload.improvementLifecycle)).toEqual(binding);
    const envelope = parseImprovementLifecycleRequestEnvelope(payload);
    expect(envelope?.requesterId).toBe("operator-1");
    expect(parseImprovementLifecycleApprovalBinding({ ...binding, scopeKind: "global" })).toBeUndefined();
    expect(parseImprovementLifecycleApprovalBinding({ ...binding, extra: 1 })).toBeUndefined();
    expect(parseImprovementLifecycleApprovalBinding({ ...binding, requestSha256: "nope" })).toBeUndefined();
    expect(parseImprovementLifecycleRequestEnvelope({ request: { requesterId: "x" } })).toBeUndefined();
    expect(
      parseImprovementLifecycleRequestEnvelope({
        request: { schemaVersion: "wrong", requesterId: "operator-1", mutation: {} },
      }),
    ).toBeUndefined();
  });

  it("keeps request hashes sensitive to every identity member", () => {
    const base = {
      workspaceId: "workspace-1",
      operationKind: "pause" as const,
      targetKind: "improvement_activation" as const,
      targetId: "activation-1",
      mutation: { a: 1 },
    };
    const hash = buildImprovementLifecycleRequestSha256(base);
    expect(buildImprovementLifecycleRequestSha256({ ...base, operationKind: "rollback" })).not.toBe(hash);
    expect(buildImprovementLifecycleRequestSha256({ ...base, targetId: "activation-2" })).not.toBe(hash);
    expect(buildImprovementLifecycleRequestSha256({ ...base, mutation: { a: 2 } })).not.toBe(hash);
    expect(buildImprovementLifecycleStateSha256({ s: 1 })).not.toBe(buildImprovementLifecycleStateSha256({ s: 2 }));
  });

  it("parses the activate and pause/rollback mutation payloads fail-closed", () => {
    const activate = {
      candidateId: "candidate-1",
      revisionId: "revision-1",
      changeHash: "hash-1",
      kind: "routing_policy",
      targetKey: "routing:target",
      preState: { hadValue: false, value: null },
      targetState: { hadValue: true, value: { strategy: "route_rebalance" } },
    };
    expect(parseImprovementActivateMutation(activate)).toEqual(activate);
    expect(parseImprovementActivateMutation({ ...activate, kind: "skill_revision" })).toBeUndefined();
    expect(parseImprovementActivateMutation({ ...activate, extra: true })).toBeUndefined();
    expect(
      parseImprovementActivateMutation({ ...activate, preState: { hadValue: "no", value: null } }),
    ).toBeUndefined();

    const pause = {
      activationId: "activation-1",
      preState: { hadValue: true, value: 1 },
      targetState: { hadValue: false, value: null },
    };
    expect(parseImprovementPauseRollbackMutation(pause)).toEqual(pause);
    expect(parseImprovementPauseRollbackMutation({ ...pause, activationId: "" })).toBeUndefined();
    expect(parseImprovementPauseRollbackMutation({ activationId: "activation-1" })).toBeUndefined();
  });

  it("derives deterministic operation/settlement/activation/inspection identities", () => {
    const operationId = deriveImprovementLifecycleOperationId("approval-1");
    expect(operationId).toMatch(UUID_PATTERN);
    expect(deriveImprovementLifecycleOperationId("approval-1")).toBe(operationId);
    expect(deriveImprovementLifecycleOperationId("approval-2")).not.toBe(operationId);
    expect(improvementLifecycleOperationIdempotencyKey("approval-1")).toBe(
      "improvement:lifecycle:operation:approval-1",
    );
    expect(deriveImprovementLifecycleSettlementId(operationId)).toMatch(UUID_PATTERN);
    expect(deriveImprovementLifecycleSettlementId(operationId)).not.toBe(operationId);
    expect(deriveImprovementLifecycleActivationId(operationId)).not.toBe(
      deriveImprovementLifecycleSettlementId(operationId),
    );
    expect(deriveImprovementLifecycleInspectionId(operationId, 2, "pre")).toBe(
      `improvement-inspection:${operationId}:2:pre`,
    );
    expect(() => deriveImprovementLifecycleInspectionId(operationId, 0, "pre")).toThrow(/positive claim generation/u);
  });

  it("hashes observed external state over its canonical bounded material", () => {
    const hash = computeImprovementLifecycleObservedStateSha256({ hadValue: true, value: { a: 1 } });
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeImprovementLifecycleObservedStateSha256({ hadValue: true, value: { a: 1 } })).toBe(hash);
    expect(computeImprovementLifecycleObservedStateSha256({ hadValue: false, value: { a: 1 } })).not.toBe(hash);
    expect(computeImprovementLifecycleObservedStateSha256({ hadValue: true, value: null })).toBe(
      computeImprovementLifecycleObservedStateSha256({ hadValue: true, value: undefined as unknown as null }),
    );
  });
});

describe("improvement lifecycle Journey evidence", () => {
  it("builds canonical requester evidence bound to the approval", () => {
    const binding = pauseBinding();
    const event = buildImprovementLifecycleRequestJourneyEvent({
      approval: { approvalId: "approval-1", createdAt: "2026-07-23T12:00:00.000Z" },
      binding,
      requesterId: "operator-1",
    });
    expect(isGovernanceJourneyEventRecord(event)).toBe(true);
    expect(event.idempotencyKey).toBe(improvementLifecycleRequestJourneyIdempotencyKey("approval-1"));
    expect(event).toMatchObject({
      scopeKind: "workspace",
      workspaceId: "workspace-1",
      eventType: "improvement_lifecycle",
      subjectKind: "improvement_activation",
      subjectId: "activation-1",
      action: "mutation_requested",
      actorId: "operator-1",
      actorType: "operator",
      approvalId: "approval-1",
      provenance: { sourceRequired: true, approvalRequired: true, phase: "requested" },
      summary: { mutationApplied: false },
    });
  });

  it("builds settlement evidence citing the approval AND the durable operation", () => {
    const binding = pauseBinding();
    const event = buildImprovementLifecycleSettlementJourneyEvent({
      binding,
      approvalId: "approval-1",
      operationId: "operation-1",
      settlementId: "settlement-1",
      inspectionId: "inspection-1",
      claimGeneration: 1,
      disposition: "applied",
      observedStateSha256: "b".repeat(64),
      actorId: "resolver-1",
      requesterId: "operator-1",
      occurredAt: "2026-07-23T12:05:00.000Z",
      activationId: "activation-1",
    });
    expect(isGovernanceJourneyEventRecord(event)).toBe(true);
    expect(event.evidenceRefs).toEqual([
      { owner: "approval", refId: "approval-1" },
      { owner: "improvement_operation", refId: "operation-1" },
    ]);
    expect(event).toMatchObject({
      action: "pause_applied",
      actorType: "approval_effect",
      sourceKind: "improvement_lifecycle_settlement",
      sourceId: "settlement-1",
      provenance: { settlementId: "settlement-1", inspectionId: "inspection-1", claimGeneration: 1 },
      summary: { disposition: "applied", mutationApplied: true, activationId: "activation-1" },
    });
    const aborted = buildImprovementLifecycleSettlementJourneyEvent({
      binding,
      approvalId: "approval-1",
      operationId: "operation-1",
      settlementId: "settlement-1",
      inspectionId: "inspection-1",
      claimGeneration: 2,
      disposition: "aborted",
      observedStateSha256: "b".repeat(64),
      actorId: "resolver-1",
      requesterId: "operator-1",
      occurredAt: "2026-07-23T12:05:00.000Z",
      reasonCode: "state_drift",
    });
    expect(aborted.action).toBe("pause_aborted");
    expect(aborted.summary.mutationApplied).toBe(false);
    expect(aborted.provenance.reasonCode).toBe("state_drift");
  });
});

describe("improvement lifecycle apply error and adapter", () => {
  it("exposes content-free terminal codes", () => {
    const error = new ImprovementLifecycleApplyError("improvement_lifecycle_state_drift");
    expect(error.code).toBe("improvement_lifecycle_state_drift");
    expect(error.name).toBe("ImprovementLifecycleApplyError");
    expect(error.message).toMatch(/drifted from the exact reviewed material/u);
  });

  it("refuses a non-transactional SQL host", () => {
    expect(() =>
      createImprovementLifecycleOperationRepository({
        dialect: "sqlite",
        prepare: () => {
          throw new Error("unused");
        },
      }),
    ).toThrow(/transactional gateway storage/u);
  });
});
