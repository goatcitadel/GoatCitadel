import {
  ConflictError,
  SemanticValidationError,
  type ChangePlanImprovementCandidateRequest,
  type ChangePlanRecord,
  type CuratorReviewItem,
  type ImprovementCandidateLifecycleResult,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";

export interface ImprovementCandidateChangePlanAdapterDependencies {
  readonly getReview: (candidateId: string) => Promise<CuratorReviewItem>;
  readonly activateCandidate: (
    candidateId: string,
    input: { actorId?: string; reason?: string },
  ) => Promise<ImprovementCandidateLifecycleResult>;
  readonly requestRollbackApproval?: (
    activationId: string,
    input: { requesterId?: string },
  ) => Promise<{
    pendingApproval: { approvalId: string } | null;
    noMutationRequired?: true;
    activation?: { status: string };
  }>;
}

/** Change Plan projection over the existing improvement lifecycle and approval owner. */
export class ImprovementCandidateChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanImprovementCandidateRequest> {
  public readonly adapterId = "improvement-candidate";
  public readonly version = 1;
  public readonly kinds = ["improvement_candidate"] as const;

  public constructor(private readonly deps: ImprovementCandidateChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanImprovementCandidateRequest) {
    const review = await this.deps.getReview(request.candidateId);
    assertWorkspace(review, context.origin.workspaceId);
    if (review.candidate.kind === "skill_revision") {
      throw new SemanticValidationError(
        "Skill improvements must be activated through their linked Code Mode capability proposal.",
      );
    }
    const ready =
      review.actionStatuses.activate === "ready" &&
      Boolean(review.currentRevision) &&
      review.latestEvaluation?.status === "passed" &&
      review.corruptionStatus === "clean";
    if (!ready) {
      return {
        target: target(review),
        title: `Review improvement: ${review.candidate.summary}`,
        summary:
          review.disabledReasons.activate ??
          "This improvement still needs owner validation before activation can be requested.",
        impact: "No runtime mutation occurs while validation or evidence is incomplete.",
        risk: riskFor(review),
        status: "manual_required" as const,
        evidenceRefs: evidenceRefs(review),
        result: {
          summary:
            review.disabledReasons.activate ??
            "Validate this candidate in the Improvement inbox, then create a fresh Change Plan.",
          failureCode: "improvement_not_ready",
        },
      };
    }
    return {
      target: target(review),
      title: `Apply improvement: ${review.candidate.summary}`,
      summary: review.proposedChange ?? review.candidate.summary,
      impact: `Apply the exact evaluated ${review.candidate.kind.replaceAll("_", " ")} revision to this workspace, then monitor it through the existing improvement owner.`,
      risk: riskFor(review),
      status: "awaiting_input" as const,
      requiredAction: context.actions.artifactReview({
        title: "Review improvement evidence",
        artifactRefs: immutableReviewRefs(review),
      }),
      evidenceRefs: evidenceRefs(review),
      rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  public async reviewArtifacts(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    reviewedArtifactRefs: readonly string[],
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const review = await this.deps.getReview(request.candidateId);
    assertWorkspace(review, context.origin.workspaceId);
    assertTarget(plan, review);
    assertExactRefs(reviewedArtifactRefs, immutableReviewRefs(review));
    return {
      status: "awaiting_confirmation",
      evidenceRefs: evidenceRefs(review),
      rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
      requiredAction: context.actions.confirmation({
        title: "Confirm this improvement",
        confirmationText:
          "Request activation of only the reviewed, evaluated revision. The improvement owner still requires its canonical approval before applying it.",
      }),
      result: { summary: "The improvement evidence was reviewed; runtime state is unchanged." },
    };
  }

  public async stage(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const review = await this.deps.getReview(request.candidateId);
    assertWorkspace(review, context.origin.workspaceId);
    assertTarget(plan, review);
    const lifecycle = await this.deps.activateCandidate(request.candidateId, {
      ...(context.origin.actorId ? { actorId: context.origin.actorId } : {}),
      reason: `Evolution Change Plan ${plan.planId}`,
    });
    if (lifecycle.mutationApplied) {
      return {
        status: "verifying",
        evidenceRefs: evidenceRefs(lifecycle.review),
        rollbackRefs: lifecycle.review.rollbackRef ? [lifecycle.review.rollbackRef] : [],
        result: { summary: "The improvement owner reports the exact revision as already active." },
      };
    }
    if (lifecycle.status !== "approval_pending" || !lifecycle.approvalId) {
      throw new SemanticValidationError("The improvement owner did not return a canonical activation approval.");
    }
    return {
      status: "awaiting_approval",
      approvalRefs: [lifecycle.approvalId],
      evidenceRefs: evidenceRefs(lifecycle.review),
      rollbackRefs: lifecycle.review.rollbackRef ? [lifecycle.review.rollbackRef] : [],
      requiredAction: context.actions.approval({
        title: "Approve improvement activation",
        risk: riskFor(lifecycle.review) === "danger" ? "danger" : "caution",
        approvalId: lifecycle.approvalId,
      }),
      result: { summary: "The improvement owner is awaiting its canonical activation approval." },
    };
  }

  public async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    return observed.applied
      ? {
          status: "verifying" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: { summary: "The improvement owner reports that the approved revision was applied." },
        }
      : {
          status: "monitoring" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: {
            summary:
              "The approval is resolved, but the improvement owner has not yet reported the exact revision as active.",
            failureCode: "improvement_activation_pending",
          },
        };
  }

  public async verify(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    return observed.applied
      ? {
          status: "completed" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: plan.result ?? { summary: "The approved improvement is active and under owner monitoring." },
        }
      : {
          status: "manual_required" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: {
            summary: "The approved improvement could not be verified as active.",
            failureCode: "improvement_not_observed",
          },
        };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    if (isRollbackReconciliation(plan)) {
      return await this.reconcileRollback(plan);
    }
    const observed = await this.observe(plan);
    return observed.applied
      ? {
          effectObserved: true,
          status: "completed" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: { summary: "Improvement owner state proves the exact approved revision is active." },
        }
      : {
          effectObserved: false,
          status: "manual_required" as const,
          evidenceRefs: observed.evidenceRefs,
          rollbackRefs: observed.rollbackRefs,
          result: {
            summary: "Improvement activation could not be proven after recovery; the Gateway did not replay it.",
            failureCode: "ambiguous_recovery",
          },
        };
  }

  public async rollback(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const review = await this.deps.getReview(request.candidateId);
    assertWorkspace(review, context.origin.workspaceId);
    assertTarget(plan, review);
    const activation = review.latestActivation;
    if (!activation) {
      throw new SemanticValidationError("The improvement has no activation record bound to its rollback material.");
    }
    if (activation.status === "rolled_back") {
      return {
        status: "rolled_back",
        evidenceRefs: evidenceRefs(review),
        rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
        result: { summary: "The improvement owner restored the exact pre-activation snapshot." },
      };
    }
    if (isRollbackApprovalResume(plan)) {
      return {
        status: "manual_required",
        evidenceRefs: evidenceRefs(review),
        rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
        result: {
          summary: `Rollback approval resolved, but the improvement owner still reports ${activation.status}.`,
          failureCode: "rollback_owner_not_settled",
        },
      };
    }
    if (!this.deps.requestRollbackApproval) {
      throw new SemanticValidationError("The governed improvement rollback owner is unavailable.");
    }
    const requested = await this.deps.requestRollbackApproval(activation.activationId, {
      ...(context.origin.actorId ? { requesterId: context.origin.actorId } : {}),
    });
    if (requested.noMutationRequired || requested.activation?.status === "rolled_back") {
      return {
        status: "rolled_back",
        evidenceRefs: evidenceRefs(review),
        rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
        result: { summary: "The improvement owner reports the exact activation as already rolled back." },
      };
    }
    const approvalId = requested.pendingApproval?.approvalId;
    if (!approvalId) {
      throw new SemanticValidationError("The improvement rollback owner did not return a canonical approval.");
    }
    return {
      status: "awaiting_approval",
      approvalRefs: [approvalId],
      evidenceRefs: evidenceRefs(review),
      rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
      requiredAction: context.actions.approval({
        title: "Approve improvement rollback",
        risk: "caution",
        approvalId,
      }),
      result: {
        summary: "The exact pre-activation snapshot is awaiting a fresh canonical rollback approval.",
        failureCode: "rollback_approval_pending",
      },
    };
  }

  private async reconcileRollback(plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const review = await this.deps.getReview(request.candidateId);
    const status = review.latestActivation?.status;
    if (status === "rolled_back") {
      return {
        effectObserved: true,
        status: "rolled_back" as const,
        evidenceRefs: evidenceRefs(review),
        rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
        result: { summary: "Improvement owner state proves the exact activation was rolled back." },
      };
    }
    return {
      effectObserved: false,
      status: "manual_required" as const,
      evidenceRefs: evidenceRefs(review),
      rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
      result: {
        summary: `Improvement rollback could not be proven after recovery${status ? `; owner status is ${status}` : ""}.`,
        failureCode: "rollback_owner_not_settled",
      },
    };
  }

  private async observe(plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const review = await this.deps.getReview(request.candidateId);
    const expectedHash = plan.target.expectedHash;
    const currentHash = review.currentRevision?.changeHash;
    const applied = review.mutationApplied && Boolean(expectedHash) && currentHash === expectedHash;
    return {
      applied,
      evidenceRefs: evidenceRefs(review),
      rollbackRefs: review.rollbackRef ? [review.rollbackRef] : [],
    };
  }
}

function isRollbackApprovalResume(plan: ChangePlanRecord): boolean {
  return (
    plan.result?.failureCode === "rollback_approval_pending" ||
    plan.result?.failureCode === "rollback_owner_not_settled"
  );
}

function isRollbackReconciliation(plan: ChangePlanRecord): boolean {
  return plan.status === "rolling_back" || isRollbackApprovalResume(plan);
}

function requireRequest(plan: ChangePlanRecord): ChangePlanImprovementCandidateRequest {
  if (plan.request.kind !== "improvement_candidate") {
    throw new SemanticValidationError("Improvement candidate Change Plan kind drifted.");
  }
  return plan.request;
}

function target(review: CuratorReviewItem) {
  return {
    ownerId: "improvement_candidate",
    resourceId: review.candidate.candidateId,
    expectedHash: review.currentRevision?.changeHash,
  };
}

function assertTarget(plan: ChangePlanRecord, review: CuratorReviewItem): void {
  if (
    plan.target.resourceId !== review.candidate.candidateId ||
    !plan.target.expectedHash ||
    plan.target.expectedHash !== review.currentRevision?.changeHash
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "The improvement candidate changed after this Change Plan was prepared.",
      details: { resourceKind: "improvement_candidate", resourceId: review.candidate.candidateId },
    });
  }
}

function assertWorkspace(review: CuratorReviewItem, workspaceId: string): void {
  if (review.candidate.workspaceId !== workspaceId) {
    throw new SemanticValidationError("The improvement candidate belongs to a different workspace.");
  }
}

function riskFor(review: CuratorReviewItem): "safe" | "caution" | "danger" {
  if (review.risk === "high" || review.callableImpact === "widens_after_approval") return "danger";
  return review.risk === "medium" ? "caution" : "safe";
}

function immutableReviewRefs(review: CuratorReviewItem): string[] {
  const refs: string[] = [];
  if (review.currentRevision) {
    refs.push(`improvement_revision:${review.currentRevision.revisionId}:sha256:${review.currentRevision.changeHash}`);
  }
  if (review.latestEvaluation) {
    refs.push(
      `improvement_evaluation:${review.latestEvaluation.evaluationId}:sha256:${review.latestEvaluation.changeHash}`,
    );
  }
  return refs.sort();
}

function evidenceRefs(review: CuratorReviewItem): string[] {
  return [
    `improvement_candidate:${review.candidate.candidateId}`,
    ...immutableReviewRefs(review),
    ...review.evidence.map((ref) => `${ref.refType}:${ref.refId}${ref.hash ? `:sha256:${ref.hash}` : ""}`),
  ];
}

function assertExactRefs(reviewed: readonly string[], current: readonly string[]): void {
  const left = [...new Set(reviewed)].sort();
  const right = [...new Set(current)].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new ConflictError({ message: "Improvement evidence changed after the review action was issued." });
  }
}
