import { describe, expect, it, vi } from "vitest";
import {
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { GovernedRemediationStoredState } from "@goatcitadel/storage";
import type { EvolutionControlPlaneAdapterContext } from "./evolution-control-plane-adapter.js";
import { RuntimeRemediationChangePlanAdapter } from "./runtime-remediation-change-plan-adapter.js";

describe("RuntimeRemediationChangePlanAdapter", () => {
  it("projects an existing remediation as manual-required when the production coordinator is absent", async () => {
    const stored = remediationState("blocked", 3);
    const adapter = new RuntimeRemediationChangePlanAdapter({ getState: () => stored });

    const prepared = await adapter.prepare(context(), { kind: "runtime_remediation", remediationId: "repair-1" });

    expect(prepared.status).toBe("manual_required");
    expect(prepared.target).toMatchObject({
      ownerId: "governed_remediation_coordinator",
      resourceId: "repair-1",
      expectedRevision: 3,
      expectedHash: "a".repeat(64),
    });
    expect(prepared.result?.failureCode).toBe("remediation_coordinator_unavailable");
  });

  it("continues only the exact revision through the canonical coordinator and observes completion", async () => {
    const stored = remediationState("blocked", 3);
    const continueRemediation = vi.fn(async () => remediationState("completed", 9));
    const adapter = new RuntimeRemediationChangePlanAdapter({
      getState: () => stored,
      continueRemediation,
    });
    const prepared = await adapter.prepare(context(), { kind: "runtime_remediation", remediationId: "repair-1" });
    const plan = {
      planId: "plan-1",
      revision: 5,
      request: { kind: "runtime_remediation", remediationId: "repair-1" },
      target: prepared.target,
      approvalRefs: ["approval-1"],
    } as unknown as ChangePlanRecord;

    const outcome = await adapter.apply(context(), plan);

    expect(continueRemediation).toHaveBeenCalledWith({
      remediationId: "repair-1",
      requesterActorId: "operator-1",
      workspaceId: "workspace-1",
      expectedStateRevision: 3,
      commandIdempotencyKey: "change-plan:plan-1:revision:5",
      action: { kind: "approve_pre_effect", approvalId: "approval-1" },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.target?.expectedRevision).toBe(9);
  });

  it("fails closed when the durable remediation revision drifts", async () => {
    const adapter = new RuntimeRemediationChangePlanAdapter({
      getState: () => remediationState("offered", 4),
      continueRemediation: vi.fn(),
    });
    const plan = {
      planId: "plan-1",
      revision: 5,
      request: { kind: "runtime_remediation", remediationId: "repair-1" },
      target: {
        ownerId: "governed_remediation_coordinator",
        resourceId: "repair-1",
        expectedRevision: 3,
        expectedHash: "a".repeat(64),
      },
      approvalRefs: ["approval-1"],
    } as unknown as ChangePlanRecord;

    await expect(adapter.apply(context(), plan)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });
});

function context(): EvolutionControlPlaneAdapterContext {
  return {
    origin: {
      surface: "chat",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      actorId: "operator-1",
    },
    actions: {
      confirmation: (input) => ({
        kind: "confirmation",
        actionId: "action-1",
        actionNonce: "nonce-1",
        title: input.title,
        confirmationText: input.confirmationText,
        purpose: input.purpose ?? "apply",
      }),
      publicForm: vi.fn(),
      secureInput: vi.fn(),
      oauth: vi.fn(),
      nativePathPicker: vi.fn(),
      approval: vi.fn(),
      artifactReview: vi.fn(),
    },
  };
}

function remediationState(
  state: GovernedRemediationStoredState["record"]["state"],
  revision: number,
): GovernedRemediationStoredState {
  return {
    ownerId: "runtime-owner",
    record: {
      schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
      remediationId: "repair-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sourceTurnId: "turn-1",
      durableRunId: "run-1",
      blockedCheckpointId: "checkpoint-1",
      requesterActorId: "operator-1",
      recipeId: "runtime.repair",
      recipeVersion: 1,
      recipeSha256: "a".repeat(64),
      scope: {
        schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
        deploymentId: "deployment-1",
        scopeKind: "workspace",
        scopeId: "workspace-1",
        targetId: "target-1",
      },
      state,
      revision,
      expectedWaitingRunVersion: 2,
      expectedOwnerRevision: "owner-revision-1",
      parentReservationId: null,
      promptId: null,
      promptExpiresAt: null,
      preEffectApprovalId: null,
      activationApprovalId: null,
      effectId: null,
      latestReceiptId: null,
      failureId: null,
      reconciliationId: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    },
  };
}
