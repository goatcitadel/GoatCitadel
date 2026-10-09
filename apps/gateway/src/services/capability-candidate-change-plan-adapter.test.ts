import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { CapabilityCandidateChangePlanAdapter, type CapabilityCandidateChangePlanAdapterDependencies } from "./capability-candidate-change-plan-adapter.js";

function fixture() {
  const candidate = {
    candidateId: "candidate-1",
    revision: 4,
    activationBlocked: false,
    activationBlockers: [],
    latestVersion: {
      versionId: "version-1",
      lifecycleState: "validated",
      wrapperManifestHash: "manifest-hash",
      manifestArtifact: { artifactId: "manifest", sha256: "a".repeat(64) },
      instructionArtifact: { artifactId: "instruction", sha256: "b".repeat(64) },
      proofArtifact: { artifactId: "proof", sha256: "c".repeat(64) },
    },
    versions: [],
  } as any;
  candidate.versions = [candidate.latestVersion];
  const proposal = {
    proposal: {
      proposalId: "proposal-1",
      candidateId: candidate.candidateId,
      title: "Generated formatter skill",
      summary: "A reviewable formatter capability.",
    },
    candidate,
  } as any;
  const promoteCandidate = vi.fn<CapabilityCandidateChangePlanAdapterDependencies["promoteCandidate"]>(async () => ({ pendingApproval: { approvalId: "approval-1" } }));
  const revokeCandidate = vi.fn<CapabilityCandidateChangePlanAdapterDependencies["revokeCandidate"]>(async () => ({ pendingApproval: { approvalId: "approval-revoke" } }));
  const rollbackCandidate = vi.fn<CapabilityCandidateChangePlanAdapterDependencies["rollbackCandidate"]>(async () => ({ pendingApproval: { approvalId: "approval-rollback" } }));
  const getCandidateDetail = vi.fn(async () => candidate);
  const adapter = new CapabilityCandidateChangePlanAdapter({
    getProposalDetail: vi.fn(async () => proposal),
    getCandidateDetail,
    promoteCandidate,
    revokeCandidate,
    rollbackCandidate,
  });
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
  return { adapter, candidate, context, getCandidateDetail, promoteCandidate, revokeCandidate, rollbackCandidate };
}

function planFrom(
  prepared: any,
  request: ChangePlanRecord["request"] = { kind: "capability_candidate", proposalId: "proposal-1" },
): ChangePlanRecord {
  return {
    planId: "plan-1",
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    request,
    target: prepared.target,
    evidenceRefs: prepared.evidenceRefs ?? [],
    rollbackRefs: [],
  } as ChangePlanRecord;
}

describe("CapabilityCandidateChangePlanAdapter", () => {
  it.each(["candidate", "revision", "hash", "workspace"])("refuses changed %s evidence before review or staging", async mismatch => {
    const f = fixture();
    f.candidate.latestVersion.workspaceId = "default";
    const prepared = await f.adapter.prepare(f.context, { kind: "capability_candidate", proposalId: "proposal-1" });
    const plan = planFrom(prepared);
    if (mismatch === "candidate") plan.target = { ...plan.target, resourceId: "foreign" };
    if (mismatch === "revision") f.candidate.revision++;
    if (mismatch === "hash") f.candidate.latestVersion.wrapperManifestHash = "changed";
    if (mismatch === "workspace") f.candidate.latestVersion.workspaceId = "foreign";
    await expect(f.adapter.reviewArtifacts(f.context, plan, prepared.requiredAction.artifactRefs)).rejects.toThrow();
    await expect(f.adapter.stage(f.context, plan)).rejects.toThrow();
    expect(f.promoteCandidate).not.toHaveBeenCalled();
    expect(f.revokeCandidate).not.toHaveBeenCalled();
    expect(f.rollbackCandidate).not.toHaveBeenCalled();
  });

  it("requires the complete original artifact reference set for review", async () => {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.context, { kind: "capability_candidate", proposalId: "proposal-1" });
    await expect(f.adapter.reviewArtifacts(f.context, planFrom(prepared), ["foreign-artifact"])).rejects.toThrow();
    expect(f.promoteCandidate).not.toHaveBeenCalled();
  });

  it.each(["activate", "revoke", "rollback"] as const)("verifies the canonical %s no-op without an approval or duplicate effect", async action => {
    const f = fixture();
    f.candidate.latestVersion.lifecycleState = action === "revoke" ? "revoked" : "approved";
    f.candidate.activeVersion = action === "revoke" ? undefined : f.candidate.latestVersion;
    const request = { kind: "capability_candidate" as const, proposalId: "proposal-1", action, versionId: "version-1" };
    const prepared = await f.adapter.prepare(f.context, request);
    const owner = action === "activate" ? f.promoteCandidate : action === "revoke" ? f.revokeCandidate : f.rollbackCandidate;
    owner.mockResolvedValueOnce({ pendingApproval: null, noMutationRequired: true, detail: f.candidate });
    const plan = planFrom(prepared, request);
    const staged = await f.adapter.stage(f.context, plan);
    expect(staged.status).toBe("verifying");
    expect(staged.approvalRefs).toBeUndefined();
    expect(staged.requiredAction).toBeUndefined();
    expect(await f.adapter.verify(f.context, { ...plan, result: staged.result })).toMatchObject({ status: "completed" });
    expect(owner).toHaveBeenCalledOnce();
    // A later contradictory owner read must not claim this no-op is still satisfied.
    f.candidate.latestVersion.lifecycleState = action === "revoke" ? "approved" : "revoked";
    f.candidate.activeVersion = action === "revoke" ? f.candidate.latestVersion : undefined;
    expect(await f.adapter.verify(f.context, plan)).toMatchObject({ status: "manual_required" });
    expect(owner).toHaveBeenCalledOnce();
  });

  it("drafts a first-time activation plan for a fresh, never-promoted candidate", async () => {
    const { adapter, candidate, context } = fixture();
    // buildCandidateDetail marks every never-promoted candidate as
    // activation-blocked (no approved/trusted version yet) — the normal
    // first-activation input, which prepare() must accept.
    candidate.activationBlocked = true;
    candidate.activationBlockers = [
      "No candidate version has been promoted into an approved or trusted lifecycle state.",
    ];
    candidate.latestVersion.lifecycleState = "candidate";

    const prepared = await adapter.prepare(context, { kind: "capability_candidate", proposalId: "proposal-1" });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("artifact_review");
  });

  it("refuses to draft activation for a revoked candidate version", async () => {
    const { adapter, candidate, context } = fixture();
    candidate.latestVersion.lifecycleState = "revoked";

    await expect(adapter.prepare(context, { kind: "capability_candidate", proposalId: "proposal-1" })).rejects.toThrow(
      "A revoked candidate version cannot be activated.",
    );
  });

  it("keeps generated capabilities non-callable through review and confirmation", async () => {
    const { adapter, context, promoteCandidate } = fixture();
    const prepared = await adapter.prepare(context, { kind: "capability_candidate", proposalId: "proposal-1" });
    expect(prepared.status).toBe("awaiting_input");
    expect(prepared.requiredAction?.kind).toBe("artifact_review");
    expect(promoteCandidate).not.toHaveBeenCalled();

    const reviewed = await adapter.reviewArtifacts!(
      context,
      planFrom(prepared),
      (prepared.requiredAction as any).artifactRefs,
    );
    expect(reviewed.status).toBe("awaiting_confirmation");
    expect(promoteCandidate).not.toHaveBeenCalled();
  });

  it("delegates activation authority to the existing canonical approval lifecycle", async () => {
    const { adapter, context, promoteCandidate } = fixture();
    const prepared = await adapter.prepare(context, { kind: "capability_candidate", proposalId: "proposal-1" });
    const staged = await adapter.stage!(context, planFrom(prepared));
    expect(staged.status).toBe("awaiting_approval");
    expect(staged.requiredAction).toMatchObject({ kind: "approval", approvalId: "approval-1" });
    expect(promoteCandidate).toHaveBeenCalledWith("candidate-1", 4, "version-1", "operator-1");
  });

  it("reconciles by observation and never replays promotion", async () => {
    const { adapter, candidate, context, getCandidateDetail, promoteCandidate } = fixture();
    candidate.activeVersion = { ...candidate.latestVersion, lifecycleState: "approved" };
    getCandidateDetail.mockResolvedValue(candidate);
    const prepared = await adapter.prepare(context, { kind: "capability_candidate", proposalId: "proposal-1" });
    const reconciled = await adapter.reconcile(context, {
      ...planFrom(prepared),
      evidenceRefs: [...prepared.evidenceRefs, "capability_candidate:candidate-1:version:version-1"],
    });
    expect(reconciled).toMatchObject({ effectObserved: true, status: "completed" });
    expect(promoteCandidate).not.toHaveBeenCalled();
  });

  it("uses the same reviewed lifecycle for exact-version revocation", async () => {
    const { adapter, candidate, context, revokeCandidate, promoteCandidate } = fixture();
    candidate.activeVersion = { ...candidate.latestVersion, lifecycleState: "approved" };
    const request = {
      kind: "capability_candidate" as const,
      proposalId: "proposal-1",
      action: "revoke" as const,
      versionId: "version-1",
    };
    const prepared = await adapter.prepare(context, request);
    const staged = await adapter.stage!(context, planFrom(prepared, request));
    expect(staged).toMatchObject({ status: "awaiting_approval" });
    expect(revokeCandidate).toHaveBeenCalledWith("candidate-1", 4, "version-1", "operator-1");
    expect(promoteCandidate).not.toHaveBeenCalled();
  });

  it("observes rollback only when the exact reviewed version is active", async () => {
    const { adapter, candidate, context, getCandidateDetail, rollbackCandidate } = fixture();
    const prior = { ...candidate.latestVersion, versionId: "version-prior", lifecycleState: "candidate" };
    candidate.versions = [candidate.latestVersion, prior];
    const request = {
      kind: "capability_candidate" as const,
      proposalId: "proposal-1",
      action: "rollback" as const,
      versionId: "version-prior",
    };
    const prepared = await adapter.prepare(context, request);
    const staged = await adapter.stage!(context, planFrom(prepared, request));
    expect(staged.status).toBe("awaiting_approval");
    expect(rollbackCandidate).toHaveBeenCalledWith("candidate-1", "version-prior", 4, "operator-1");

    candidate.activeVersion = { ...prior, lifecycleState: "approved" };
    getCandidateDetail.mockResolvedValue(candidate);
    const reconciled = await adapter.reconcile(context, planFrom(prepared, request));
    expect(reconciled).toMatchObject({ effectObserved: true, status: "completed" });
  });
});
