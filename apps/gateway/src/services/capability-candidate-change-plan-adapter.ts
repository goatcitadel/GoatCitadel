import {
  ConflictError,
  SemanticValidationError,
  type CandidateSkillDetailRecord,
  type CandidateSkillVersionRecord,
  type CapabilityProposalDetailRecord,
  type ChangePlanCapabilityCandidateRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";

type CandidateMutationOutcome =
  | { readonly pendingApproval: { readonly approvalId: string } }
  | {
      readonly pendingApproval: null;
      readonly noMutationRequired: true;
      readonly detail: CandidateSkillDetailRecord;
    };

export interface CapabilityCandidateChangePlanAdapterDependencies {
  readonly getProposalDetail: (proposalId: string) => Promise<CapabilityProposalDetailRecord>;
  readonly getCandidateDetail: (candidateId: string) => Promise<CandidateSkillDetailRecord>;
  readonly promoteCandidate: (
    candidateId: string,
    expectedRevision: number,
    versionId: string | undefined,
    requesterId: string | undefined,
  ) => Promise<CandidateMutationOutcome>;
  readonly revokeCandidate: (
    candidateId: string,
    expectedRevision: number,
    versionId: string | undefined,
    requesterId: string | undefined,
  ) => Promise<CandidateMutationOutcome>;
  readonly rollbackCandidate: (
    candidateId: string,
    targetVersionId: string,
    expectedRevision: number,
    requesterId: string | undefined,
  ) => Promise<CandidateMutationOutcome>;
}

/**
 * Links Change Plans to the existing Code Mode proposal/candidate ledger. The
 * capability owner still verifies immutable artifacts and creates the
 * canonical lifecycle approval; this adapter never writes skill files or the
 * callable catalog directly.
 */
export class CapabilityCandidateChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanCapabilityCandidateRequest> {
  public readonly adapterId = "capability-candidate";
  public readonly version = 2;
  public readonly kinds = ["capability_candidate"] as const;

  public constructor(private readonly deps: CapabilityCandidateChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanCapabilityCandidateRequest) {
    const resolved = await this.resolve(request, context.origin.workspaceId);
    const action = request.action ?? "activate";
    if (action !== "revoke") assertCandidateReviewable(resolved.candidate);
    const copy = actionCopy(action, resolved.proposal.proposal.title);
    return {
      target: {
        ownerId: "capability_candidate",
        resourceId: resolved.candidate.candidateId,
        expectedRevision: resolved.candidate.revision,
        expectedHash: resolved.version.wrapperManifestHash ?? resolved.version.manifestArtifact.sha256,
      },
      title: copy.planTitle,
      summary: resolved.proposal.proposal.summary,
      impact: copy.impact,
      risk: "danger" as const,
      status: "awaiting_input" as const,
      requiredAction: context.actions.artifactReview({
        title: copy.reviewTitle,
        artifactRefs: artifactRefs(resolved.version),
      }),
      evidenceRefs: [
        `capability_proposal:${resolved.proposal.proposal.proposalId}`,
        `capability_candidate:${resolved.candidate.candidateId}:revision:${resolved.candidate.revision}`,
      ],
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  public async reviewArtifacts(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    reviewedArtifactRefs: readonly string[],
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const resolved = await this.resolve(request, context.origin.workspaceId);
    assertTarget(plan, resolved.candidate, resolved.version);
    assertExactRefs(reviewedArtifactRefs, artifactRefs(resolved.version));
    const action = request.action ?? "activate";
    const copy = actionCopy(action, resolved.proposal.proposal.title);
    return {
      status: "awaiting_confirmation",
      evidenceRefs: [
        `capability_proposal:${request.proposalId}`,
        `capability_candidate:${resolved.candidate.candidateId}:revision:${resolved.candidate.revision}`,
      ],
      requiredAction: context.actions.confirmation({
        title: copy.confirmTitle,
        confirmationText: copy.confirmationText,
      }),
      result: { summary: copy.reviewedSummary },
    };
  }

  public async stage(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const resolved = await this.resolve(request, context.origin.workspaceId);
    assertTarget(plan, resolved.candidate, resolved.version);
    const action = request.action ?? "activate";
    const outcome =
      action === "activate"
        ? await this.deps.promoteCandidate(
            resolved.candidate.candidateId,
            resolved.candidate.revision,
            resolved.version.versionId,
            context.origin.actorId,
          )
        : action === "revoke"
          ? await this.deps.revokeCandidate(
              resolved.candidate.candidateId,
              resolved.candidate.revision,
              resolved.version.versionId,
              context.origin.actorId,
            )
          : await this.deps.rollbackCandidate(
              resolved.candidate.candidateId,
              resolved.version.versionId,
              resolved.candidate.revision,
              context.origin.actorId,
            );
    const copy = actionCopy(action, resolved.proposal.proposal.title);
    if ("noMutationRequired" in outcome && outcome.noMutationRequired) {
      return {
        status: "completed",
        evidenceRefs: lifecycleEvidence(outcome.detail, resolved.version.versionId),
        result: { summary: copy.noopSummary },
      };
    }
    const approvalId = outcome.pendingApproval?.approvalId;
    if (!approvalId) {
      throw new SemanticValidationError(
        "The capability lifecycle owner did not return its canonical approval binding.",
      );
    }
    return {
      status: "awaiting_approval",
      approvalRefs: [approvalId],
      evidenceRefs: [
        `capability_proposal:${request.proposalId}`,
        `capability_candidate:${resolved.candidate.candidateId}:version:${resolved.version.versionId}`,
      ],
      requiredAction: context.actions.approval({
        title: copy.approvalTitle,
        risk: "danger",
        approvalId,
      }),
      result: { summary: copy.awaitingApprovalSummary },
    };
  }

  public async apply(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const observed = await this.observe(plan);
    const copy = actionCopy(observed.action, plan.title);
    return observed.effectObserved
      ? {
          status: "verifying",
          evidenceRefs: observed.evidenceRefs,
          result: { summary: copy.observedSummary },
        }
      : {
          status: "monitoring",
          evidenceRefs: observed.evidenceRefs,
          result: {
            summary: copy.pendingObservationSummary,
            failureCode: `${observed.action}_pending_observation`,
          },
        };
  }

  public async verify(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    const copy = actionCopy(observed.action, plan.title);
    return observed.effectObserved
      ? {
          status: "completed" as const,
          evidenceRefs: observed.evidenceRefs,
          result: plan.result ?? { summary: copy.completedSummary },
        }
      : {
          status: "manual_required" as const,
          evidenceRefs: observed.evidenceRefs,
          result: {
            summary: copy.notObservedSummary,
            failureCode: `capability_${observed.action}_not_observed`,
          },
        };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    const copy = actionCopy(observed.action, plan.title);
    return observed.effectObserved
      ? {
          effectObserved: true,
          status: "completed" as const,
          evidenceRefs: observed.evidenceRefs,
          result: { summary: copy.reconciledSummary },
        }
      : {
          effectObserved: false,
          status: "manual_required" as const,
          evidenceRefs: observed.evidenceRefs,
          result: {
            summary: copy.recoverySummary,
            failureCode: "ambiguous_recovery",
          },
        };
  }

  private async resolve(request: ChangePlanCapabilityCandidateRequest, workspaceId: string) {
    const proposal = await this.deps.getProposalDetail(request.proposalId);
    const candidate = proposal.candidate;
    if (!candidate || !proposal.proposal.candidateId) {
      throw new SemanticValidationError("The capability proposal has no generated candidate to review.");
    }
    if (proposal.proposal.candidateId !== candidate.candidateId) {
      throw new ConflictError({ message: "Capability proposal and candidate linkage drifted." });
    }
    const runWorkspaceId = candidate.originatingRun?.workspaceId;
    if (runWorkspaceId && runWorkspaceId !== workspaceId) {
      throw new SemanticValidationError("The capability proposal belongs to a different workspace.");
    }
    const version = request.versionId
      ? candidate.versions.find((item) => item.versionId === request.versionId)
      : candidate.latestVersion;
    if (!version) throw new SemanticValidationError("The capability candidate has no immutable version artifacts.");
    return { proposal, candidate, version };
  }

  private async observe(plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const action = request.action ?? "activate";
    const candidateId = plan.target.resourceId;
    const detail = await this.deps.getCandidateDetail(candidateId);
    const expectedVersion =
      request.versionId ?? versionIdFromEvidence(plan.evidenceRefs) ?? detail.latestVersion?.versionId;
    const selected = detail.versions.find((item) => item.versionId === expectedVersion);
    const effectObserved =
      action === "revoke"
        ? Boolean(selected?.lifecycleState === "revoked" && detail.activeVersion?.versionId !== expectedVersion)
        : Boolean(
            expectedVersion &&
            detail.activeVersion?.versionId === expectedVersion &&
            ["approved", "trusted"].includes(detail.activeVersion.lifecycleState) &&
            !detail.activationBlocked,
          );
    return { action, effectObserved, evidenceRefs: lifecycleEvidence(detail, expectedVersion) };
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanCapabilityCandidateRequest {
  if (plan.request.kind !== "capability_candidate") {
    throw new SemanticValidationError("Capability candidate Change Plan kind drifted.");
  }
  return plan.request;
}

function assertCandidateReviewable(candidate: CandidateSkillDetailRecord): void {
  if (candidate.activationBlocked) {
    throw new SemanticValidationError("The capability candidate is not eligible for activation.", {
      blockers: candidate.activationBlockers,
    });
  }
}

function assertTarget(
  plan: ChangePlanRecord,
  candidate: CandidateSkillDetailRecord,
  version: CandidateSkillVersionRecord,
): void {
  if (plan.target.resourceId !== candidate.candidateId || plan.target.expectedRevision !== candidate.revision) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "The capability candidate changed after this Change Plan was prepared.",
      details: {
        resourceKind: "capability_candidate",
        resourceId: candidate.candidateId,
        expectedRevision: plan.target.expectedRevision,
        currentRevision: candidate.revision,
      },
    });
  }
  const currentHash = version.wrapperManifestHash ?? version.manifestArtifact.sha256;
  if (plan.target.expectedHash !== currentHash) {
    throw new ConflictError({
      message: "The immutable capability version hash changed after this Change Plan was prepared.",
    });
  }
}

function artifactRefs(version: CandidateSkillVersionRecord): string[] {
  return [
    version.manifestArtifact,
    version.instructionArtifact,
    version.proofArtifact,
    version.programArtifact,
    version.schemaArtifact,
  ]
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
    .map((artifact) => `capability_artifact:${artifact.artifactId}:sha256:${artifact.sha256}`)
    .sort();
}

function assertExactRefs(reviewed: readonly string[], current: readonly string[]): void {
  const left = [...new Set(reviewed)].sort();
  const right = [...new Set(current)].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new ConflictError({ message: "Capability artifacts changed after the review action was issued." });
  }
}

function lifecycleEvidence(detail: CandidateSkillDetailRecord, selectedVersionId?: string): string[] {
  const refs = [`capability_candidate:${detail.candidateId}:revision:${detail.revision}`];
  const selected = detail.versions.find((item) => item.versionId === selectedVersionId);
  if (selected)
    refs.push(
      `capability_candidate:${detail.candidateId}:version:${selected.versionId}:state:${selected.lifecycleState}`,
    );
  if (detail.activeVersion)
    refs.push(`capability_candidate:${detail.candidateId}:version:${detail.activeVersion.versionId}`);
  return refs;
}

function versionIdFromEvidence(refs: readonly string[]): string | undefined {
  const marker = ":version:";
  const ref = refs.find((candidate) => candidate.startsWith("capability_candidate:") && candidate.includes(marker));
  return ref ? ref.slice(ref.indexOf(marker) + marker.length).split(":", 1)[0] : undefined;
}

function actionCopy(action: "activate" | "revoke" | "rollback", title: string) {
  if (action === "revoke") {
    return {
      planTitle: `Review revocation of ${title}`,
      impact:
        "After artifact review and exact confirmation, the capability owner requires its separate danger approval. The selected version is removed from the callable catalog only by that owner.",
      reviewTitle: "Review the capability version to revoke",
      confirmTitle: `Confirm revocation request for ${title}`,
      confirmationText:
        "Request revocation of the exact reviewed capability version. A separate danger approval is still required before callable state changes.",
      reviewedSummary: "The immutable capability version was reviewed; no revocation has occurred.",
      noopSummary: "The reviewed capability version was already revoked; no mutation was required.",
      approvalTitle: `Approve ${title} revocation`,
      awaitingApprovalSummary: "The capability owner is awaiting its canonical revocation approval.",
      observedSummary: "The capability lifecycle owner reports the exact reviewed version as revoked.",
      pendingObservationSummary:
        "The approval is resolved, but capability revocation has not yet been observed. The Gateway will reconcile owner state without replaying it.",
      completedSummary: "The reviewed capability version is revoked and non-callable.",
      notObservedSummary: "The exact reviewed capability version is not revoked after lifecycle settlement.",
      reconciledSummary: "Owner state proves the exact reviewed capability version is revoked.",
      recoverySummary: "Capability revocation could not be proven after recovery; the Gateway did not replay it.",
    };
  }
  if (action === "rollback") {
    return {
      planTitle: `Review rollback to ${title}`,
      impact:
        "After artifact review and exact confirmation, the capability owner requires its separate danger approval before replacing callable state with the selected prior version.",
      reviewTitle: "Review the capability version to restore",
      confirmTitle: `Confirm rollback request for ${title}`,
      confirmationText:
        "Request rollback to the exact reviewed capability version. A separate danger approval is still required before callable state changes.",
      reviewedSummary: "The immutable rollback target was reviewed; no callable state has changed.",
      noopSummary: "The reviewed rollback target was already active; no mutation was required.",
      approvalTitle: `Approve ${title} rollback`,
      awaitingApprovalSummary: "The capability owner is awaiting its canonical rollback approval.",
      observedSummary: "The capability lifecycle owner reports the exact reviewed rollback target as active.",
      pendingObservationSummary:
        "The approval is resolved, but capability rollback has not yet been observed. The Gateway will reconcile owner state without replaying it.",
      completedSummary: "The reviewed capability rollback target is active and callable.",
      notObservedSummary: "The exact reviewed rollback target is not active after lifecycle settlement.",
      reconciledSummary: "Owner state proves the exact reviewed rollback target is active.",
      recoverySummary: "Capability rollback could not be proven after recovery; the Gateway did not replay it.",
    };
  }
  return {
    planTitle: `Review ${title}`,
    impact:
      "After artifact review and final confirmation, the capability owner may request its separate danger approval. The candidate remains non-callable until that owner completes activation.",
    reviewTitle: "Review generated capability artifacts",
    confirmTitle: `Confirm activation request for ${title}`,
    confirmationText:
      "Request the exact reviewed candidate version from the capability lifecycle owner. A separate danger approval is still required before it can become callable.",
    reviewedSummary: "The immutable capability artifacts were reviewed; no activation has occurred.",
    noopSummary: "The reviewed capability version was already active; no mutation was required.",
    approvalTitle: `Approve ${title} activation`,
    awaitingApprovalSummary: "The capability owner is awaiting its canonical activation approval.",
    observedSummary: "The capability lifecycle owner reports the exact reviewed version as active.",
    pendingObservationSummary:
      "The approval is resolved, but capability activation has not yet been observed. The Gateway will reconcile owner state without replaying activation.",
    completedSummary: "The reviewed capability is active and callable.",
    notObservedSummary: "The exact reviewed capability version is not active after lifecycle settlement.",
    reconciledSummary: "Owner state proves the exact reviewed capability version is active.",
    recoverySummary: "Capability activation could not be proven after recovery; the Gateway did not replay it.",
  };
}
