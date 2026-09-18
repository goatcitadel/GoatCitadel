import { canonicalJsonString, normalizeRemoteWorkerRuntimeBundleManifest, normalizeRemoteWorkerRuntimeInstallRequest,
  remoteWorkerRuntimeInstallRequestSha256, remoteWorkerRuntimeBundleManifestSha256, normalizeRemoteWorkerControllerEnrollment, type ApprovalCreateInput } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerCellCapacityAuthority, type RemoteWorkerRuntimeInstallPreparationInput } from "@goatcitadel/storage";
import type { ApprovalRuntime } from "./approval-runtime-service.js";

/** Trusted package-owner review entry, never a worker approval/dispatch RPC.
 * ApprovalRuntime owns creation, events and cancellation after commit. This
 * Review retention never grants copy admission or retries a lost response. */
export class RemoteWorkerRuntimeInstallReviewService {
  constructor(private readonly storage: Pick<AsyncStorage, "remoteWorkerRuntimeInstalls" | "approvals">,
    private readonly approvals?: Pick<ApprovalRuntime, "createApproval">) {}

  /** Resolve review material from storage, not a caller-supplied request. The
   * retention repository locks and rechecks approval, parent and cell authority
   * before writing. This entry does not resolve approvals or authorize copying. */
  public async retainApprovedReview(input: RemoteWorkerCellCapacityAuthority & { readonly approvalId: string; readonly signal?: AbortSignal }) {
    const signal = input.signal;
    signal?.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), approvalId = input.approvalId;
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.trim() !== approvalId || approvalId.length > 200)
      throw new Error("Installation retention requires an exact approval identifier.");
    const approval = await this.storage.approvals.get(approvalId);
    signal?.throwIfAborted();
    const binding = approval.payload.nativeRuntimeInstall as Record<string, unknown> | undefined;
    if (approval.approvalId !== approvalId || approval.status !== "approved" || approval.kind !== "remote_worker.native_runtime_install" ||
        !binding || binding.schemaVersion !== "goatcitadel.native-runtime-install-approval.v1" ||
        binding.registryWorkspaceId !== authority.registryWorkspaceId || binding.assignmentId !== authority.assignmentId ||
        binding.assignmentGeneration !== authority.assignmentGeneration)
      throw new Error("Installation retention requires the canonical approved review for this assignment.");
    const request = normalizeRemoteWorkerRuntimeInstallRequest(binding.request);
    const revision = (name: string): number => {
      const value = binding[name];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
        throw new Error("Installation review revision is invalid.");
      return value;
    };
    const command = Object.freeze({ ...authority, approvalId, request,
      expectedExecutionRevision: revision("expectedExecutionRevision"), expectedCleanupRevision: revision("expectedCleanupRevision"),
      expectedCapacityRevision: revision("expectedCapacityRevision"), expectedBackupRevision: revision("expectedBackupRevision") });
    const retained = await this.storage.remoteWorkerRuntimeInstalls.retainRequestForAssignment(command);
    // Retention has committed; late cancellation must not report it as undone.
    return Object.freeze({ decision: "review_retained" as const, approvalId, request: retained,
      requestSha256: remoteWorkerRuntimeInstallRequestSha256(retained) });
  }

  public async requestReview(input: RemoteWorkerRuntimeInstallPreparationInput & { readonly signal?: AbortSignal; readonly controllerEnrollment?: unknown }) {
    if (!this.approvals) throw new Error("Installation review requires the canonical approval lifecycle.");
    const signal = input.signal;
    signal?.throwIfAborted();
    const controllerEnrollment = input.controllerEnrollment === undefined ? undefined : normalizeRemoteWorkerControllerEnrollment(input.controllerEnrollment);
    const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
      packageSha256: input.packageSha256, runtimeBundle: normalizeRemoteWorkerRuntimeBundleManifest(input.runtimeBundle) });
    if (!/^[a-f0-9]{64}$/u.test(command.packageSha256) || /^0+$/u.test(command.packageSha256))
      throw new Error("Installation review requires an exact package hash.");
    const prepared = await this.storage.remoteWorkerRuntimeInstalls.prepareRequestForAssignment(command);
    signal?.throwIfAborted();
    const request = normalizeRemoteWorkerRuntimeInstallRequest(prepared.request), requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request);
    const revisions = Object.freeze({ expectedExecutionRevision: prepared.revisions.expectedExecutionRevision,
      expectedCleanupRevision: prepared.revisions.expectedCleanupRevision, expectedCapacityRevision: prepared.revisions.expectedCapacityRevision,
      expectedBackupRevision: prepared.revisions.expectedBackupRevision }), draft = prepared.approvalDraft;
    const binding = draft.payload.nativeRuntimeInstall as Record<string, unknown>;
    if (prepared.decision !== "review_required" || prepared.requestSha256 !== requestSha256 || request.packageSha256 !== command.packageSha256 ||
        canonicalJsonString(request.runtimeBundle) !== canonicalJsonString(command.runtimeBundle) ||
        Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 0) || draft.kind !== "remote_worker.native_runtime_install" ||
        draft.riskLevel !== "danger" || !binding || typeof binding.profileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binding.profileSha256) ||
        canonicalJsonString(binding) !== canonicalJsonString({ schemaVersion: "goatcitadel.native-runtime-install-approval.v1",
          registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration,
          profileSha256: binding.profileSha256, request, ...revisions }) || draft.linkage?.actionType !== "remote_worker.native_runtime_install")
      throw new Error("Installation review candidate differs from its canonical request.");
    const approvalDraft: ApprovalCreateInput = Object.freeze({ kind: draft.kind, riskLevel: draft.riskLevel,
      payload: Object.freeze({ nativeRuntimeInstall: Object.freeze({ ...binding, request, ...revisions }),
        ...(controllerEnrollment ? { controllerEnrollment } : {}) }), linkage: Object.freeze({ ...draft.linkage }),
      preview: Object.freeze({ title: "Install reviewed runtime package", packageSha256: request.packageSha256, requestSha256,
        runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(request.runtimeBundle), files: request.runtimeBundle.files,
        totalBytes: request.runtimeBundle.files.reduce((total, file) => total + file.bytes, 0),
        ...(controllerEnrollment ? { controllerKeySha256: controllerEnrollment.keySha256 } : {}) }) });
    const candidate = Object.freeze({ decision: "review_required" as const, request, requestSha256, revisions, approvalDraft });
    const approval = await this.approvals.createApproval(approvalDraft, async pending => {
      signal?.throwIfAborted();
      await this.storage.remoteWorkerRuntimeInstalls.validatePendingReviewForAssignment({ ...command, approvalId: pending.approvalId, request });
      signal?.throwIfAborted();
    }, { ttlMs: 300000 });
    // A committed approval remains visible even if the caller cancels afterward.
    return Object.freeze({ candidate, approval });
  }
}
