import { ConflictError, normalizeRemoteWorkerRuntimeReadKey, normalizeRemoteWorkerRuntimeBundleManifest } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, snapshotRemoteWorkerRuntimeRequestPreparation,
  type RemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import type { RemoteWorkerRuntimeRequestProducer } from "./remote-worker-runtime-request-producer.js";
import type { RemoteWorkerRuntimeInstallReviewService } from "./remote-worker-runtime-install-review-service.js";
export interface RemoteWorkerNativeReviewRequest {
  registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number;
  launch: unknown; inventoryLimits: unknown; fileStaging?: unknown; discloseFilesToGateway?: boolean;
}
type ReviewScope = Pick<RemoteWorkerNativeReviewRequest, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
export type RemoteWorkerInstallationReviewRequest = ReviewScope & { packageSha256: string; runtimeBundle: unknown; controllerEnrollment?: unknown };
const unavailable = () => new ConflictError({ message: "Native review requires recent protected worker contact and current assignment policy." });
/** Operator-only preparation bridge. Signed worker requests contribute current
 * authority, never executable requests. The operator supplies the review input;
 * canonical policy, approval, native inventory and admission still own launch. */
export class RemoteWorkerNativeReviewOperator {
  private readonly observed = new Map<string, { authority: RemoteWorkerCellCapacityAuthority; at: number }>();
  constructor(private readonly producer: Pick<RemoteWorkerRuntimeRequestProducer, "requestReview">, private readonly now = () => performance.now(),
    private readonly installations?: Pick<RemoteWorkerRuntimeInstallReviewService, "requestReview" | "retainApprovedReview">) {}
  private key(input: Pick<RemoteWorkerNativeReviewRequest, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">) {
    const key = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId });
    if (!Number.isSafeInteger(input.assignmentGeneration) || input.assignmentGeneration < 1 || input.assignmentGeneration > 2147483647) throw unavailable();
    return JSON.stringify([key.registryWorkspaceId, key.assignmentId, input.assignmentGeneration]);
  }
  private prune(now: number) { for (const [key, entry] of this.observed) if (now < entry.at || now - entry.at > 30000) this.observed.delete(key); }
  private authority(input: ReviewScope, signal: AbortSignal) {
    signal.throwIfAborted(); const key = this.key(input); this.prune(this.now());
    const entry = this.observed.get(key); if (!entry) throw unavailable();
    return entry.authority;
  }
  /** Called only after the existing signature, nonce and transactional lease
   * fence. Cached contact cannot replace fresh checks in producer/storage. */
  public observe(input: RemoteWorkerCellCapacityAuthority): void {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), key = this.key(authority), now = this.now(); this.prune(now);
    const previous = this.observed.get(key); if (previous && previous.authority.leaseRevision > authority.leaseRevision) return;
    this.observed.delete(key); this.observed.set(key, { authority, at: now });
    while (this.observed.size > 32) this.observed.delete(this.observed.keys().next().value!);
  }
  public async requestReview(input: RemoteWorkerNativeReviewRequest, signal: AbortSignal) {
    const command = snapshotRemoteWorkerRuntimeRequestPreparation({ ...this.authority(input, signal), launch: input.launch, inventoryLimits: input.inventoryLimits,
      ...(input.fileStaging === undefined ? {} : { fileStaging: input.fileStaging }),
      ...(input.discloseFilesToGateway === undefined ? {} : { discloseFilesToGateway: input.discloseFilesToGateway }) });
    const result = await this.producer.requestReview({ ...command, signal });
    // A committed approval remains inspectable even if contact expires while
    // creating it. Do not hide it or automatically recreate an uncertain review.
    return Object.freeze({ approvalId: result.approval.approvalId, status: result.approval.status,
      expiresAt: result.approval.expiresAt ?? null, requestSha256: result.candidate.candidateExpectation.requestSha256 });
  }
  /** Prepare an operator-selected package review; this does not approve it,
   * register a native capture, admit copying or retry installation. */
  public async requestInstallationReview(input: RemoteWorkerInstallationReviewRequest, signal: AbortSignal) {
    const authority = this.authority(input, signal);
    if (!this.installations) throw unavailable();
    const result = await this.installations.requestReview({ ...authority, packageSha256: input.packageSha256,
      runtimeBundle: normalizeRemoteWorkerRuntimeBundleManifest(input.runtimeBundle),
      ...(input.controllerEnrollment === undefined ? {} : { controllerEnrollment: input.controllerEnrollment }), signal });
    return Object.freeze({ approvalId: result.approval.approvalId, status: result.approval.status,
      expiresAt: result.approval.expiresAt ?? null, requestSha256: result.candidate.requestSha256 });
  }
  /** Retain only the exact request from an already approved canonical review.
   * The repository rechecks current authority and every reviewed revision. */
  public async retainInstallationReview(input: ReviewScope & { approvalId: string }, signal: AbortSignal) {
    const authority = this.authority(input, signal);
    if (!this.installations) throw unavailable();
    const result = await this.installations.retainApprovedReview({ ...authority, approvalId: input.approvalId, signal });
    return Object.freeze({ decision: result.decision, approvalId: result.approvalId, requestSha256: result.requestSha256 });
  }
}
