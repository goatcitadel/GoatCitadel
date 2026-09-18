import { afterEach, describe, expect, it } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { governedRemediationApprovalKind } from "@goatcitadel/contracts";
import { createRemediationParentFixture, createRemediationResumeFixture } from "../../../../packages/storage/src/governed-remediation-parent-reservation-fixture.js";
import { GOVERNED_BUDGETS_MIRROR_RECIPE } from "./governed-remediation-budgets-mirror-recipe.js";
import type { GovernedRemediationAuthorityRequest } from "./governed-remediation-coordinator.js";
import { buildGovernedRemediationApprovalPayload, GovernedRemediationApprovalAuthority } from "./governed-remediation-approval-authority.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture(withReceipts = false) {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  const seed = withReceipts ? createRemediationResumeFixture(storage.db) : createRemediationParentFixture(storage.db);
  const state = storage.governedRemediations.getState(seed.input.remediationId);
  // The registry boundary is tested separately; this suite exercises actual approval persistence.
  const recipe = { ...GOVERNED_BUDGETS_MIRROR_RECIPE, recipeId: state.record.recipeId, ownerId: state.ownerId };
  const payload = buildGovernedRemediationApprovalPayload(state, recipe, "pre_effect");
  const kind = governedRemediationApprovalKind("pre_effect");
  const linkage = { workspaceId: state.record.workspaceId, sessionId: state.record.sessionId,
    turnId: state.record.sourceTurnId, runId: state.record.durableRunId, actionType: kind, operatorId: state.record.requesterActorId };
  const create = (overrides: Partial<Parameters<typeof storage.approvals.create>[0]> = {}) => storage.approvals.create({
    kind, riskLevel: "caution", payload: { ...payload }, preview: {}, linkage,
    expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides });
  const approval = create();
  const request: GovernedRemediationAuthorityRequest = { ...state.record,
    stateRevision: state.record.revision, phaseAggregateKind: "state", phaseAggregateId: state.record.remediationId,
    phaseAggregateRevision: state.record.revision, operationId: seed.input.operationId, phase: "preflight", ownerId: state.ownerId,
    requestedCapabilityId: recipe.requestedCapabilityId, deploymentProfile: "local_dev",
    approvalPurpose: "pre_effect", approvalId: approval.approvalId };
  const authority = new GovernedRemediationApprovalAuthority(createSqliteAsyncStorage(storage));
  return { storage, state, recipe, payload, linkage, create, approval, request, authority };
}

describe("governed remediation approval evidence", () => {
  it("requires an approved, unexpired, exact-purpose decision from the requester", async () => {
    const f = fixture();
    expect(await f.authority.verify(f.request, f.state, f.recipe)).toBe(false);
    f.storage.approvals.resolve(f.approval.approvalId, { decision: "approve", resolvedBy: f.state.record.requesterActorId });
    expect(await f.authority.verify(f.request, f.state, f.recipe)).toBe(true);
    for (const patch of [{ requesterActorId: "foreign" }, { workspaceId: "foreign" }, { stateRevision: 1 },
      { recipeSha256: "b".repeat(64) }, { approvalPurpose: "activation" as const }, { approvalPurpose: null, approvalId: null }]) {
      expect(await f.authority.verify({ ...f.request, ...patch }, f.state, f.recipe)).toBe(false);
    }
    f.storage.db.prepare("UPDATE approvals SET expires_at = @expires WHERE approval_id = @id")
      .run({ expires: "2000-01-01T00:00:00.000Z", id: f.approval.approvalId });
    expect(await f.authority.verify(f.request, f.state, f.recipe)).toBe(false);
  });

  it("rejects generic confirmations, foreign actors, edited scope, extra payload, and linkage drift", async () => {
    const f = fixture();
    for (const overrides of [{ kind: "change_plan.confirmation" }, { payload: { ...f.payload, workspaceId: "foreign" } },
      { payload: { ...f.payload, extra: true } }, { linkage: { ...f.linkage, runId: "foreign" } },
      { linkage: { ...f.linkage, durableRunId: "foreign" } }, {}]) {
      const approval = f.create(overrides);
      f.storage.approvals.resolve(approval.approvalId, { decision: "approve",
        resolvedBy: Object.keys(overrides).length ? f.state.record.requesterActorId : "another-operator" });
      expect(await f.authority.verify({ ...f.request, approvalId: approval.approvalId }, f.state, f.recipe)).toBe(false);
    }
    const noExpiry = f.create({ expiresAt: undefined });
    f.storage.approvals.resolve(noExpiry.approvalId, { decision: "approve", resolvedBy: f.state.record.requesterActorId });
    expect(await f.authority.verify({ ...f.request, approvalId: noExpiry.approvalId }, f.state, f.recipe)).toBe(false);
  });

  it("binds activation to an application receipt and cannot reuse pre-effect approval", async () => {
    const f = fixture();
    expect(() => buildGovernedRemediationApprovalPayload(f.state, f.recipe, "activation")).toThrow();
    const payload = buildGovernedRemediationApprovalPayload(f.state, f.recipe, "activation",
      { receiptId: "application-exact", ownerRevisionAfter: "revision-after" });
    expect(payload.applicationReceiptId).toBe("application-exact");
    expect(payload.expectedOwnerRevision).toBe("revision-after");
    f.storage.approvals.resolve(f.approval.approvalId, { decision: "approve", resolvedBy: f.state.record.requesterActorId });
    const state = { ...f.state, record: { ...f.state.record, preEffectApprovalId: f.approval.approvalId } };
    expect(await f.authority.verify({ ...f.request, phase: "activate", approvalPurpose: "activation" }, state, f.recipe)).toBe(false);
  });

  it("checks the persisted application for activation and its post-activation probe", async () => {
    const f = fixture(true);
    // Phase-lease checks belong to the authority owner; this projection exercises
    // the approval verifier against the fixture's real application/verification receipts.
    const state = { ...f.state, record: { ...f.state.record, state: "activating" as const } };
    const recipe = { ...f.recipe, activationApproval: "required" as const };
    const kind = governedRemediationApprovalKind("activation");
    const payload = buildGovernedRemediationApprovalPayload(state, recipe, "activation",
      { receiptId: "resume-application", ownerRevisionAfter: "owner-revision-2" });
    const approval = f.create({ kind, payload: { ...payload }, linkage: { ...f.linkage, actionType: kind } });
    f.storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: state.record.requesterActorId });
    for (const phase of ["activate", "probe"] as const) {
      const request = { ...f.request, phase, approvalId: approval.approvalId, approvalPurpose: "activation" as const };
      expect(await f.authority.verify(request, state, recipe)).toBe(true);
      expect(await f.authority.verify({ ...request, approvalPurpose: "pre_effect" }, state, recipe)).toBe(false);
      expect(await f.authority.verify({ ...request, approvalPurpose: null, approvalId: null }, state, recipe)).toBe(false);
    }
    const wrong = f.create({ kind, payload: { ...payload, applicationReceiptId: "foreign" }, linkage: { ...f.linkage, actionType: kind } });
    f.storage.approvals.resolve(wrong.approvalId, { decision: "approve", resolvedBy: state.record.requesterActorId });
    expect(await f.authority.verify({ ...f.request, phase: "activate", approvalId: wrong.approvalId, approvalPurpose: "activation" }, state, recipe)).toBe(false);
  });
});
