import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ImprovementCandidateChangePlanAdapter } from "./improvement-candidate-change-plan-adapter.js";

function fixture() {
  const review = {
    candidate: {
      candidateId: "improvement-1",
      workspaceId: "default",
      kind: "routing_policy",
      summary: "Prefer the healthy provider for document turns",
    },
    currentRevision: { revisionId: "revision-1", changeHash: "d".repeat(64) },
    latestEvaluation: { evaluationId: "evaluation-1", changeHash: "d".repeat(64), status: "passed" },
    evidence: [],
    risk: "medium",
    callableImpact: "none",
    mutationApplied: false,
    runtimeProvenCallable: false,
    corruptionStatus: "clean",
    actionStatuses: { activate: "ready" },
    disabledReasons: {},
  } as any;
  const getReview = vi.fn(async () => review);
  const activateCandidate = vi.fn(
    async () =>
      ({
        action: "activate",
        status: "approval_pending",
        review,
        approvalId: "approval-2",
        mutationApplied: false,
      }) as any,
  );
  const adapter = new ImprovementCandidateChangePlanAdapter({ getReview, activateCandidate });
  const context = {
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    actions: {
      artifactReview: (input: any) => ({
        kind: "artifact_review",
        actionId: "review-1",
        actionNonce: "nonce-review",
        ...input,
      }),
      confirmation: (input: any) => ({
        kind: "confirmation",
        actionId: "confirm-1",
        actionNonce: "nonce-confirm",
        ...input,
      }),
      approval: (input: any) => ({
        kind: "approval",
        actionId: "approval-action-1",
        actionNonce: "nonce-approval",
        ...input,
      }),
    },
  } as any;
  return { activateCandidate, adapter, context, getReview, review };
}

function planFrom(prepared: any): ChangePlanRecord {
  return {
    planId: "plan-2",
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    request: { kind: "improvement_candidate", candidateId: "improvement-1" },
    target: prepared.target,
    evidenceRefs: prepared.evidenceRefs ?? [],
    rollbackRefs: prepared.rollbackRefs ?? [],
  } as ChangePlanRecord;
}

describe("ImprovementCandidateChangePlanAdapter", () => {
  it("requires immutable evidence review before exact confirmation", async () => {
    const { activateCandidate, adapter, context } = fixture();
    const prepared = await adapter.prepare(context, { kind: "improvement_candidate", candidateId: "improvement-1" });
    expect(prepared.requiredAction?.kind).toBe("artifact_review");
    expect(activateCandidate).not.toHaveBeenCalled();
    const reviewed = await adapter.reviewArtifacts!(
      context,
      planFrom(prepared),
      (prepared.requiredAction as any).artifactRefs,
    );
    expect(reviewed.status).toBe("awaiting_confirmation");
    expect(activateCandidate).not.toHaveBeenCalled();
  });

  it("links the exact candidate to its existing activation approval", async () => {
    const { activateCandidate, adapter, context } = fixture();
    const prepared = await adapter.prepare(context, { kind: "improvement_candidate", candidateId: "improvement-1" });
    const staged = await adapter.stage!(context, planFrom(prepared));
    expect(staged).toMatchObject({
      status: "awaiting_approval",
      requiredAction: { kind: "approval", approvalId: "approval-2" },
    });
    expect(activateCandidate).toHaveBeenCalledWith("improvement-1", expect.objectContaining({ actorId: "operator-1" }));
  });

  it("refuses the direct skill-revision path", async () => {
    const { adapter, context, review } = fixture();
    review.candidate.kind = "skill_revision";
    await expect(
      adapter.prepare(context, { kind: "improvement_candidate", candidateId: "improvement-1" }),
    ).rejects.toThrow(/Code Mode capability proposal/);
  });

  it("requires a fresh canonical approval before rolling back the bound activation", async () => {
    const { activateCandidate, context, getReview, review } = fixture();
    review.rollbackRef = "improvement-rollback:snapshot-1";
    review.latestActivation = {
      activationId: "activation-1",
      status: "active",
      watchStartedAt: "2026-08-14T00:00:00.000Z",
    };
    const requestRollbackApproval = vi.fn(async () => ({
      pendingApproval: { approvalId: "approval-rollback-1" },
    }));
    const adapter = new ImprovementCandidateChangePlanAdapter({
      getReview,
      activateCandidate,
      requestRollbackApproval,
    });
    const prepared = await adapter.prepare(context, { kind: "improvement_candidate", candidateId: "improvement-1" });
    const plan = {
      ...planFrom(prepared),
      status: "rolling_back",
      rollbackRefs: [review.rollbackRef],
    } as ChangePlanRecord;
    const pending = await adapter.rollback!(context, plan);
    expect(requestRollbackApproval).toHaveBeenCalledWith("activation-1", { requesterId: "operator-1" });
    expect(pending).toMatchObject({
      status: "awaiting_approval",
      requiredAction: { kind: "approval", approvalId: "approval-rollback-1" },
      result: { failureCode: "rollback_approval_pending" },
    });

    review.latestActivation.status = "rolled_back";
    const settled = await adapter.rollback!(context, {
      ...plan,
      result: { summary: "Approval pending.", failureCode: "rollback_approval_pending" },
    });
    expect(settled.status).toBe("rolled_back");
    expect(requestRollbackApproval).toHaveBeenCalledTimes(1);
  });
});
