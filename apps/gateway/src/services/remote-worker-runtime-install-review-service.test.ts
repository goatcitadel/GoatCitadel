import { describe, expect, it, vi } from "vitest";
import { hashRemoteWorkerControllerPublicKey, remoteWorkerRuntimeInstallRequestSha256, type ApprovalRequest } from "@goatcitadel/contracts";
import type { RemoteWorkerRuntimeInstallPreparationInput, RemoteWorkerRuntimeInstallRequestInput } from "@goatcitadel/storage";
import type { ApprovalRuntime } from "./approval-runtime-service.js";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";

function fixture() {
  const stop = new AbortController();
  const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
    packageSha256: "2".repeat(64), runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1", files: [
      { relativePath: "node.exe", bytes: 100, sha256: "3".repeat(64) },
      { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "4".repeat(64) },
    ] }, signal: stop.signal } as unknown as RemoteWorkerRuntimeInstallPreparationInput & { signal: AbortSignal };
  const request = { schemaVersion: "goatcitadel.worker-runtime-install.v1" as const, nonce: "5".repeat(64), journalIdentityHex: "6".repeat(48),
    preparedSha256: "7".repeat(64), checkpointSha256: "8".repeat(64), packageSha256: input.packageSha256, runtimeBundle: input.runtimeBundle };
  const revisions = { expectedExecutionRevision: 1, expectedCleanupRevision: 1, expectedCapacityRevision: 3, expectedBackupRevision: 1 };
  const candidate = { decision: "review_required" as const, request, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request), revisions,
    approvalDraft: { kind: "remote_worker.native_runtime_install", riskLevel: "danger" as const, payload: {
      nativeRuntimeInstall: { schemaVersion: "goatcitadel.native-runtime-install-approval.v1", registryWorkspaceId: input.registryWorkspaceId,
        assignmentId: input.assignmentId, assignmentGeneration: 1, profileSha256: "9".repeat(64), request, ...revisions } },
      linkage: { workspaceId: "workspace", taskId: "task", durableRunId: "run", sessionId: "session", turnId: "turn", actionType: "remote_worker.native_runtime_install" } } };
  const prepareRequestForAssignment = vi.fn(async (_input: RemoteWorkerRuntimeInstallPreparationInput) => candidate);
  const validatePendingReviewForAssignment = vi.fn(async () => {});
  const createApproval = vi.fn<ApprovalRuntime["createApproval"]>(async (draft, hook) => {
    const approval = { ...draft, approvalId: "installation-review", status: "pending" as const,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), explanationStatus: "not_requested" as const };
    await hook?.(approval);
    return approval;
  });
  const llm = {};
  const approved: ApprovalRequest = { ...candidate.approvalDraft, approvalId: "installation-review", status: "approved",
    createdAt: new Date().toISOString(), explanationStatus: "not_requested" };
  const get = vi.fn(async (_id: string) => approved);
  const retainRequestForAssignment = vi.fn(async (command: RemoteWorkerRuntimeInstallRequestInput) => command.request);
  const dependencies = { storage: { approvals: { get }, remoteWorkerRuntimeInstalls: { prepareRequestForAssignment, validatePendingReviewForAssignment, retainRequestForAssignment } },
    approvals: { createApproval }, llm, completionHost: { llmService: llm }, artifactRoot: "unused-install-review" } as unknown as RemoteWorkerExecutionOwnersDependencies;
  const owner = createRemoteWorkerExecutionOwners(dependencies).nativeInstallationReviews;
  return { input, request, candidate, stop, createApproval, prepareRequestForAssignment, validatePendingReviewForAssignment, owner,
    approved, get, retainRequestForAssignment };
}

describe("canonical installation review composition", () => {
  it("binds the operator public pin into the immutable approval and review preview", async () => {
    const f = fixture(), publicPointHex = `04${"12".repeat(64)}`;
    const controllerEnrollment = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
    const result = await f.owner.requestReview({ ...f.input, controllerEnrollment });
    expect(result.approval.payload.controllerEnrollment).toEqual(controllerEnrollment);
    expect(result.candidate.approvalDraft.preview).toMatchObject({ controllerKeySha256: controllerEnrollment.keySha256 });
    controllerEnrollment.publicPointHex = "changed";
    expect(result.approval.payload.controllerEnrollment).toMatchObject({ publicPointHex });
    expect(result.candidate.requestSha256).toBe(f.candidate.requestSha256);
  });
  it("refuses a mismatched controller pin before preparing or creating approval", async () => {
    const f = fixture();
    await expect(f.owner.requestReview({ ...f.input, controllerEnrollment: {
      publicPointHex: `04${"12".repeat(64)}`, keySha256: "ab".repeat(32) } })).rejects.toThrow();
    expect(f.prepareRequestForAssignment).not.toHaveBeenCalled();
    expect(f.createApproval).not.toHaveBeenCalled();
  });
  it("retains the canonical approved request and ignores caller-supplied review material", async () => {
    const f = fixture();
    const command = { ...f.input, approvalId: f.approved.approvalId, request: { nonce: "foreign" }, expectedCapacityRevision: 999 };
    await expect(f.owner.retainApprovedReview(command)).resolves.toMatchObject({ decision: "review_retained", request: f.request,
      requestSha256: f.candidate.requestSha256 });
    expect(f.get).toHaveBeenCalledWith(f.approved.approvalId);
    const { signal: _signal, packageSha256: _package, runtimeBundle: _bundle, ...authority } = f.input;
    expect(f.retainRequestForAssignment).toHaveBeenCalledWith({ ...authority, approvalId: f.approved.approvalId,
      request: f.request, ...f.candidate.revisions });
    expect(Object.isFrozen(f.retainRequestForAssignment.mock.calls[0]![0])).toBe(true);
    expect(f.createApproval).not.toHaveBeenCalled();
  });
  it.each(["pending", "rejected", "foreign", "kind", "revision", "missing"])("refuses invalid approved review: %s", async mode => {
    const f = fixture();
    if (mode === "pending" || mode === "rejected") f.approved.status = mode;
    if (mode === "foreign") f.candidate.approvalDraft.payload.nativeRuntimeInstall.assignmentId = "foreign";
    if (mode === "kind") f.approved.kind = "remote_worker.native_runtime";
    if (mode === "revision") f.candidate.approvalDraft.payload.nativeRuntimeInstall.expectedCapacityRevision = -1;
    if (mode === "missing") f.get.mockRejectedValue(new Error("missing"));
    await expect(f.owner.retainApprovedReview({ ...f.input, approvalId: f.approved.approvalId })).rejects.toThrow();
    expect(f.retainRequestForAssignment).not.toHaveBeenCalled();
  });
  it.each(["before", "read", "committed"])("respects retention cancellation at %s", async stage => {
    const f = fixture();
    if (stage === "before") f.stop.abort();
    if (stage === "read") f.get.mockImplementation(async () => { f.stop.abort(); return f.approved; });
    if (stage === "committed") f.retainRequestForAssignment.mockImplementation(async command => { f.stop.abort(); return command.request; });
    const pending = f.owner.retainApprovedReview({ ...f.input, approvalId: f.approved.approvalId });
    if (stage === "committed") await expect(pending).resolves.toMatchObject({ decision: "review_retained" });
    else await expect(pending).rejects.toThrow();
    expect(f.retainRequestForAssignment).toHaveBeenCalledTimes(stage === "committed" ? 1 : 0);
  });
  it.each(["revoked", "lost response"])("propagates %s from transactional retention without retry", async error => {
    const f = fixture(); f.retainRequestForAssignment.mockRejectedValue(new Error(error));
    await expect(f.owner.retainApprovedReview({ ...f.input, approvalId: f.approved.approvalId })).rejects.toThrow(error);
    expect(f.retainRequestForAssignment).toHaveBeenCalledTimes(1);
    expect(f.createApproval).not.toHaveBeenCalled();
  });
  it("creates the exact review through the lifecycle with a pending authority hook", async () => {
    const f = fixture(), result = await f.owner.requestReview(f.input);
    expect(result.approval.status).toBe("pending");
    expect(result.candidate.approvalDraft.preview).toMatchObject({ totalBytes: 120, requestSha256: f.candidate.requestSha256 });
    expect(f.createApproval).toHaveBeenCalledWith(result.candidate.approvalDraft, expect.any(Function), { ttlMs: 300000 });
    const { signal: _signal, ...command } = f.input;
    expect(f.validatePendingReviewForAssignment).toHaveBeenCalledWith({ ...command, approvalId: "installation-review", request: f.request });
    expect(Object.isFrozen(f.prepareRequestForAssignment.mock.calls[0]?.[0])).toBe(true);
  });
  it.each(["before", "prepared", "hook", "committed"])("preserves cancellation truth at %s", async stage => {
    const f = fixture();
    if (stage === "before") f.stop.abort();
    if (stage === "prepared") f.prepareRequestForAssignment.mockImplementation(async () => { f.stop.abort(); return f.candidate; });
    if (stage === "hook") f.validatePendingReviewForAssignment.mockImplementation(async () => { f.stop.abort(); });
    if (stage === "committed") {
      const original = f.createApproval.getMockImplementation()!;
      f.createApproval.mockImplementation(async (...args) => { const value = await original(...args); f.stop.abort(); return value; });
    }
    if (stage === "committed") await expect(f.owner.requestReview(f.input)).resolves.toMatchObject({ approval: { status: "pending" } });
    else await expect(f.owner.requestReview(f.input)).rejects.toThrow();
    expect(f.createApproval).toHaveBeenCalledTimes(["before", "prepared"].includes(stage) ? 0 : 1);
  });
  it.each(["request", "scope", "revision", "digest"])("refuses a substituted %s before creation", async field => {
    const f = fixture();
    if (field === "request") f.candidate.request.packageSha256 = "a".repeat(64);
    if (field === "scope") f.candidate.approvalDraft.payload.nativeRuntimeInstall.assignmentId = "foreign";
    if (field === "revision") f.candidate.revisions.expectedCapacityRevision++;
    if (field === "digest") f.candidate.requestSha256 = "b".repeat(64);
    await expect(f.owner.requestReview(f.input)).rejects.toThrow();
    expect(f.createApproval).not.toHaveBeenCalled();
  });
  it("propagates revoked pending authority without returning a review", async () => {
    const f = fixture(); f.validatePendingReviewForAssignment.mockRejectedValue(new Error("revoked"));
    await expect(f.owner.requestReview(f.input)).rejects.toThrow("revoked");
    expect(f.createApproval).toHaveBeenCalledTimes(1);
  });
  it("does not retry a lost lifecycle response", async () => {
    const f = fixture(); f.createApproval.mockRejectedValue(new Error("lost response"));
    await expect(f.owner.requestReview(f.input)).rejects.toThrow("lost response");
    expect(f.createApproval).toHaveBeenCalledTimes(1);
    expect(f.prepareRequestForAssignment).toHaveBeenCalledTimes(1);
  });
});
