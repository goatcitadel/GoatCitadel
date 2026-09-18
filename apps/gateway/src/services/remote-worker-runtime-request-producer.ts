import { canonicalJsonString, remoteWorkerAssignmentCanonicalSha256 as digest, normalizeRemoteWorkerRuntimeResultExpectation,
  normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  type ApprovalCreateInput, type ApprovalRequest, type ApprovalNativeRuntimeReview } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { snapshotRemoteWorkerRuntimeRequestPreparation, snapshotRemoteWorkerCellCapacityInventoryAdmission, snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeAdmissionInput,
  type RemoteWorkerRuntimeRequestPreparationInput, type RemoteWorkerRuntimeRequestPreparation } from "@goatcitadel/storage";
import type { ApprovalRuntime } from "./approval-runtime-service.js";
import { normalizeRemoteWorkerNativeContinuation, type RemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import type { RemoteWorkerNativeRuntimePolicyPort } from "./remote-worker-native-runtime-policy.js";

/** Gateway-internal preparation for the existing governed execution owner.
 * Never expose this as worker request approval or a dispatch RPC. The returned
 * candidate must pass the existing policy/approval owner before atomic admission.
 * No cell transition, expectation write or process launch happens here. */
export class RemoteWorkerRuntimeRequestProducer {
  private readonly reviews = new Map<string, { candidate: RemoteWorkerRuntimeRequestPreparation; expiresAt: number; bytes: number; admissionAttempted?: boolean; admitted?: boolean }>();
  private pendingReviews = 0;
  private reservedBytes = 0;
  public constructor(private readonly storage: Pick<AsyncStorage, "remoteWorkerRuntimeAdmissions" | "remoteWorkerRuntimeResults" | "approvals" | "remoteWorkerAssignments" | "remoteWorkerNativeCapacityPages">,
    private readonly approvals?: Pick<ApprovalRuntime, "createApproval">,
    private readonly policy?: RemoteWorkerNativeRuntimePolicyPort) {}

  /** Trusted execution-owner handoff only. The caller must present the candidate
   * for review; this creates a pending decision, never dispatch authority.
   * Do not automatically retry a lost creation response. */
  public async requestReview(input: RemoteWorkerRuntimeRequestPreparationInput & { readonly signal?: AbortSignal }) {
    if (!this.approvals) throw new Error("Native runtime review requires the canonical approval lifecycle.");
    this.pruneReviews();
    if (this.reviews.size + this.pendingReviews >= 32) throw new Error("Native runtime review capacity is full; wait for existing review context to expire.");
    this.pendingReviews += 1;
    let reserved = 0;
    try {
      const signal = input.signal, command = snapshotRemoteWorkerRuntimeRequestPreparation(input);
      const candidate = await this.prepare({ ...command, signal });
      signal?.throwIfAborted();
      const bytes = Buffer.byteLength(canonicalJsonString(candidate.request));
      if (this.reservedBytes + [...this.reviews.values()].reduce((sum, review) => sum + review.bytes, 0) + bytes > 4 * 1024 * 1024)
        throw new Error("Native runtime review memory capacity is full.");
      this.reservedBytes += bytes; reserved = bytes;
      const approval = await this.approvals.createApproval(candidate.approvalDraft, async (pending) => {
        signal?.throwIfAborted();
        await this.storage.remoteWorkerRuntimeAdmissions.validatePendingReviewForAssignment({ ...command,
          approvalId: pending.approvalId, request: candidate.request });
        signal?.throwIfAborted();
      }, { ttlMs: 300_000 });
      // A cancellation after commit must not hide the retained decision. The
      // lifecycle may have auto-rejected it; preserve that canonical status.
      const expiresAt = Math.min(Date.parse(approval.expiresAt ?? ""), Date.now() + 300_000);
      if (approval.status === "pending" && Number.isFinite(expiresAt) && expiresAt > Date.now())
        this.reviews.set(approval.approvalId, { candidate, expiresAt, bytes });
      return Object.freeze({ candidate, approval });
    } finally { this.pendingReviews -= 1; this.reservedBytes -= reserved; }
  }

  /** The caller supplies a freshly read canonical approval, never request JSON.
   * Expiry, restart or changed bindings yield unavailable details, not a rebuild. */
  public readReview(approval: ApprovalRequest): ApprovalNativeRuntimeReview | undefined {
    this.pruneReviews();
    const review = this.reviews.get(approval.approvalId);
    if (!review || approval.kind !== "remote_worker.native_runtime" || !["pending", "approved"].includes(approval.status) ||
        Date.parse(approval.expiresAt ?? "") <= Date.now() || !Number.isFinite(Date.parse(approval.expiresAt ?? "")) ||
        canonicalJsonString(approval.payload.nativeRuntime) !== canonicalJsonString(review.candidate.approvalDraft.payload.nativeRuntime) ||
        canonicalJsonString(approval.payload.nativeFileDisclosure ?? null) !== canonicalJsonString(review.candidate.approvalDraft.payload.nativeFileDisclosure ?? null)) return undefined;
    const links = review.candidate.approvalDraft.linkage;
    if ((["workspaceId", "taskId", "durableRunId", "sessionId", "turnId", "actionType"] as const).some(key =>
      approval.linkage?.[key] !== links?.[key])) return undefined;
    const { launch, fileStaging } = review.candidate.request;
    const disclosure = approval.payload.nativeFileDisclosure === undefined ? undefined : normalizeRemoteWorkerNativeFileDisclosure(approval.payload.nativeFileDisclosure);
    return Object.freeze({ requestSha256: review.candidate.candidateExpectation.requestSha256, imagePath: launch.image,
      commandLine: launch.commandLine, workingDirectory: launch.directory, environment: Object.freeze({ ...launch.environment }), limits: Object.freeze({ ...launch.limits }),
      ...(fileStaging === undefined ? {} : { fileStaging }),
      ...(disclosure ? { fileDisclosure: Object.freeze({ destination: disclosure.destination, workspaceId: disclosure.executionWorkspaceId }) } : {}) });
  }

  private pruneReviews(): void {
    const now = Date.now();
    for (const [id, review] of this.reviews) if (review.expiresAt <= now) this.reviews.delete(id);
  }

  /** Select only a confirmed admission for this canonical assignment. Request
   * bytes remain ephemeral and are never reconstructed after restart or expiry.
   * Selection is not execution: the native intent ledger still owns replay
   * prevention, and every runtime callback must check current authority again. */
  public async selectAdmittedForAssignment(input: Omit<RemoteWorkerRuntimeRequestPreparationInput, "launch" | "inventoryLimits" | "fileStaging" | "discloseFilesToGateway"> & {
    readonly signal?: AbortSignal; readonly continuation?: RemoteWorkerNativeContinuation }) {
    const signal = input.signal, command = snapshotRemoteWorkerCellCapacityAuthority(input);
    const continuation = input.continuation === undefined ? undefined : normalizeRemoteWorkerNativeContinuation(input.continuation);
    if (continuation && (continuation.decision !== "approved" || continuation.assignmentGeneration !== command.assignmentGeneration))
      throw new Error("Native request selection requires its approved continuation.");
    signal?.throwIfAborted();
    if (continuation) await this.admitContinuation(command, continuation, signal);
    const select = () => {
      this.pruneReviews();
      const matches = [...this.reviews.entries()].filter(([approvalId, review]) => {
        const binding = review.candidate.approvalDraft.payload.nativeRuntime as Record<string, unknown>;
        return review.admitted && binding.registryWorkspaceId === command.registryWorkspaceId &&
          binding.assignmentId === command.assignmentId && binding.assignmentGeneration === command.assignmentGeneration &&
          (!continuation || (approvalId === continuation.approvalId && digest(binding) === continuation.nativeRuntimeBindingSha256));
      }).map(([, review]) => review);
      if (matches.length !== 1) throw new Error("No unique admitted native request is available; reconcile the assignment.");
      return matches[0]!;
    };
    const review = select(), expected = review.candidate.candidateExpectation;
    await this.authorizeCandidate(command, review.candidate, signal, true);
    const current = normalizeRemoteWorkerRuntimeResultExpectation(await this.storage.remoteWorkerRuntimeResults.authorizeForAssignment({
      ...command, nonce: expected.nonce, requestSha256: expected.requestSha256, phase: "execution" }));
    signal?.throwIfAborted();
    if (continuation) {
      const resume = await this.storage.remoteWorkerAssignments.resolveActiveChatApprovalResume({ registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration, leaseTokenSha256: command.leaseTokenSha256 }, command.protectedAuthority);
      signal?.throwIfAborted();
      if (!resume || resume.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume.v1" ||
          resume.materialSha256 !== continuation.resumeSha256 || resume.material.approvalId !== continuation.approvalId ||
          resume.material.approvalSha256 !== continuation.approvalSha256 || resume.material.nativeRuntimeBindingSha256 !== continuation.nativeRuntimeBindingSha256)
        throw new Error("Native request selection differs from its canonical continuation.");
    }
    if (select() !== review || canonicalJsonString(current) !== canonicalJsonString(expected))
      throw new Error("Native request selection changed during authorization.");
    return Object.freeze({ request: review.candidate.request, expectation: expected });
  }

  /** Signed continuation selects existing review metadata only. Capacity and
   * executable bytes are resolved from their independent retained owners. */
  private async admitContinuation(authority: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority>, continuation: RemoteWorkerNativeContinuation, signal?: AbortSignal) {
    this.pruneReviews();
    const review = this.reviews.get(continuation.approvalId);
    if (!review || review.admitted) return;
    if (review.admissionAttempted) throw new Error("Native admission was already attempted; reconcile retained state.");
    const binding = review.candidate.approvalDraft.payload.nativeRuntime as Record<string, unknown>;
    if (binding.registryWorkspaceId !== authority.registryWorkspaceId || binding.assignmentId !== authority.assignmentId ||
        binding.assignmentGeneration !== authority.assignmentGeneration || digest(binding) !== continuation.nativeRuntimeBindingSha256)
      throw new Error("Native continuation does not match its reviewed request.");
    const resume = await this.storage.remoteWorkerAssignments.resolveActiveChatApprovalResume({ registryWorkspaceId: authority.registryWorkspaceId,
      assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration, leaseTokenSha256: authority.leaseTokenSha256 }, authority.protectedAuthority);
    signal?.throwIfAborted();
    if (!resume || resume.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume.v1" ||
        resume.materialSha256 !== continuation.resumeSha256 || resume.material.approvalId !== continuation.approvalId ||
        resume.material.approvalSha256 !== continuation.approvalSha256 || resume.material.nativeRuntimeBindingSha256 !== continuation.nativeRuntimeBindingSha256)
      throw new Error("Native admission requires the exact canonical Chat continuation.");
    const material = await this.storage.remoteWorkerNativeCapacityPages.readAdmissionForAssignment({ ...authority, ...review.candidate.revisions });
    signal?.throwIfAborted();
    if (Object.entries(review.candidate.revisions).some(([key, value]) => material[key as keyof typeof review.candidate.revisions] !== value))
      throw new Error("Native admission material differs from the reviewed revisions.");
    const request = review.candidate.request, limits = request.launch.limits;
    // Admission demand is conservative request/input/output capacity, not a
    // fabricated measurement. The existing inventory and high-water values stay.
    const incomingBytes = Math.max(material.observation.incomingBytes, Buffer.byteLength(canonicalJsonString(request)) +
      limits.inputBytes + limits.rawOutputBytes + limits.diagnosticBytes + (request.fileStaging?.maximumTotalBytes ?? 0));
    await this.admitReviewed({ ...material, ...authority, ...review.candidate.revisions, approvalId: continuation.approvalId,
      observation: { ...material.observation, incomingBytes }, signal });
  }

  /** Final storage admission from the reviewed, private candidate. The caller
   * supplies current protected authority and a trusted complete collection,
   * never an executable request or an approval verdict. This does not launch a
   * process or replace the dispatch owner's current policy/runtime checks. */
  public async admitReviewed(input: Omit<RemoteWorkerRuntimeAdmissionInput, "request" | "expectation"> & { readonly signal?: AbortSignal }) {
    const signal = input.signal, approvalId = input.approvalId;
    signal?.throwIfAborted();
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 200) throw new Error("A retained native runtime review is required.");
    const command = snapshotRemoteWorkerCellCapacityInventoryAdmission(input);
    this.pruneReviews();
    const review = this.reviews.get(approvalId);
    if (!review || review.admissionAttempted) throw new Error("Native runtime admission is unavailable or already attempted; reconcile retained state.");
    const { candidate } = review;
    const binding = candidate.approvalDraft.payload.nativeRuntime as Record<string, unknown>;
    if (command.registryWorkspaceId !== binding.registryWorkspaceId || command.assignmentId !== binding.assignmentId ||
        command.assignmentGeneration !== binding.assignmentGeneration ||
        Object.entries(candidate.revisions).some(([name, value]) => command[name as keyof typeof candidate.revisions] !== value))
      throw new Error("Native runtime admission must match the reviewed assignment and revisions.");
    const approval = await this.storage.approvals.get(approvalId);
    await this.authorizeCandidate(command, candidate, signal);
    signal?.throwIfAborted();
    if (approval.status !== "approved" || !this.readReview(approval) || this.reviews.get(approvalId) !== review || review.admissionAttempted)
      throw new Error("Native runtime admission requires its current resolved review.");
    if (candidate.approvalDraft.linkage?.sessionId || candidate.approvalDraft.linkage?.turnId) {
      // Chat execution must re-enter the canonical parent and rotate its worker
      // lease. A decision alone cannot advance the parked execution.
      const resume = await this.storage.remoteWorkerAssignments.resolveActiveChatApprovalResume({
        registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId,
        assignmentGeneration: command.assignmentGeneration, leaseTokenSha256: command.leaseTokenSha256,
      }, command.protectedAuthority);
      signal?.throwIfAborted();
      if (!resume || resume.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume.v1" ||
          resume.material.approvalId !== approvalId || resume.material.approvalSha256 !== digest(approval) ||
          resume.material.nativeRuntimeBindingSha256 !== digest(binding))
        throw new Error("Native runtime admission requires its exact protected Chat resume.");
      // Another continuation may have consumed the candidate while this read
      // awaited storage. Expiry and cancellation do not authorize admission.
      if (!this.readReview(approval) || this.reviews.get(approvalId) !== review || review.admissionAttempted)
        throw new Error("Native runtime admission is unavailable or already attempted; reconcile retained state.");
    }
    // Consume before crossing the commit boundary. Rejection, cancellation and
    // an ambiguous response never permit an automatic second admission call.
    review.admissionAttempted = true;
    if (!this.policy) throw new Error("Native admission requires the canonical policy commit owner.");
    const admission = await this.policy.admit({ ...command, approvalId,
      request: candidate.request, expectation: candidate.candidateExpectation, signal });
    if (admission.decision !== "accept") {
      if (admission.decision !== "reject" && admission.decision !== "quarantine") throw new Error("Native runtime admission response requires reconciliation.");
      return Object.freeze({ disposition: admission.decision, admission });
    }
    const { cell } = admission;
    if (canonicalJsonString(normalizeRemoteWorkerRuntimeResultExpectation(admission.expectation)) !== canonicalJsonString(candidate.candidateExpectation) ||
        cell.registryWorkspaceId !== command.registryWorkspaceId || cell.assignmentId !== command.assignmentId || cell.assignmentGeneration !== command.assignmentGeneration ||
        cell.profileSha256 !== binding.profileSha256 || cell.executionState !== "starting" || cell.executionRevision !== command.expectedExecutionRevision + 1 ||
        cell.capacityRevision !== command.expectedCapacityRevision + 1 || cell.cleanupRevision !== command.expectedCleanupRevision || cell.backupRevision !== command.expectedBackupRevision)
      throw new Error("Native runtime admission response requires reconciliation.");
    if (signal?.aborted) return Object.freeze({ disposition: "admitted_cancelled" as const, admission });
    review.admitted = true;
    return Object.freeze({ disposition: "admitted" as const, admission, request: candidate.request });
  }

  public async prepare(input: RemoteWorkerRuntimeRequestPreparationInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerRuntimeRequestPreparation> {
    const signal = input.signal;
    signal?.throwIfAborted();
    const command = snapshotRemoteWorkerRuntimeRequestPreparation(input);
    if (this.policy) await this.policy.authorize({ ...command, signal });
    signal?.throwIfAborted();
    const result = await this.storage.remoteWorkerRuntimeAdmissions.prepareRequestForAssignment(command);
    signal?.throwIfAborted();
    const request = normalizeWindowsRuntimeDispatch(result.request);
    const candidateExpectation = normalizeRemoteWorkerRuntimeResultExpectation(result.candidateExpectation);
    const revisions = { expectedCapacityRevision: result.revisions.expectedCapacityRevision, expectedExecutionRevision: result.revisions.expectedExecutionRevision,
      expectedCleanupRevision: result.revisions.expectedCleanupRevision, expectedBackupRevision: result.revisions.expectedBackupRevision };
    if (result.decision !== "review_required" || Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 0) ||
        JSON.stringify(request.launch) !== JSON.stringify(command.launch) || JSON.stringify(request.inventoryLimits) !== JSON.stringify(command.inventoryLimits) ||
        JSON.stringify(request.fileStaging) !== JSON.stringify(command.fileStaging) ||
        JSON.stringify(prepareWindowsRuntimeDispatch(request).expectation) !== JSON.stringify(candidateExpectation))
      throw new Error("Native runtime preparation requires a bound review candidate.");
    const draft = result.approvalDraft, binding = draft.payload.nativeRuntime as Record<string, unknown>, links = draft.linkage;
    const expectedBinding = { schemaVersion: "goatcitadel.native-runtime-approval.v1", registryWorkspaceId: command.registryWorkspaceId,
      assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration, profileSha256: binding.profileSha256,
      expectation: candidateExpectation, ...revisions };
    if (draft.kind !== "remote_worker.native_runtime" || draft.riskLevel !== "danger" || typeof binding.profileSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(binding.profileSha256) || canonicalJsonString(binding) !== canonicalJsonString(expectedBinding) ||
        links?.actionType !== "remote_worker.native_runtime" || [links.workspaceId, links.taskId, links.durableRunId].some(value => typeof value !== "string" || !value.trim()) ||
        (links.sessionId === undefined) !== (links.turnId === undefined) ||
        [links.sessionId, links.turnId].some(value => value !== undefined && (typeof value !== "string" || !value.trim())))
      throw new Error("Native runtime review requires canonical execution links and request bindings.");
    const approvalDraft: ApprovalCreateInput = Object.freeze({ kind: draft.kind, riskLevel: draft.riskLevel,
      payload: Object.freeze({ nativeRuntime: Object.freeze(expectedBinding), ...this.fileDisclosurePayload(command, draft, request, candidateExpectation) }),
      preview: Object.freeze({ title: command.discloseFilesToGateway ? "Review native launch and file transfer" : "Review native runtime launch", requestSha256: candidateExpectation.requestSha256,
        runtimeBundleSha256: candidateExpectation.runtimeBundleSha256, maxOutputBytes: candidateExpectation.maxOutputBytes }),
      linkage: Object.freeze({ workspaceId: links.workspaceId, taskId: links.taskId, durableRunId: links.durableRunId,
        ...(links.sessionId === undefined ? {} : { sessionId: links.sessionId, turnId: links.turnId }), actionType: links.actionType }) });
    return Object.freeze({ decision: "review_required", request, candidateExpectation, approvalDraft, revisions: Object.freeze(revisions) });
  }

  /** Current execution/input/output checks use the same privately reviewed
   * request; no worker-supplied command or cached policy verdict is accepted. */
  public async authorizePolicyForRequest(input: Omit<RemoteWorkerRuntimeRequestPreparationInput, "launch" | "inventoryLimits" | "fileStaging" | "discloseFilesToGateway"> & {
    nonce: string; requestSha256: string; signal?: AbortSignal;
  }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input); this.pruneReviews();
    const matches = [...this.reviews.values()].filter(review => review.admitted && review.candidate.candidateExpectation.nonce === input.nonce &&
      review.candidate.candidateExpectation.requestSha256 === input.requestSha256);
    if (matches.length !== 1) throw new Error("Native runtime has no unique current reviewed policy request.");
    await this.authorizeCandidate(authority, matches[0]!.candidate, input.signal, true);
    this.pruneReviews();
    if (![...this.reviews.values()].includes(matches[0]!)) throw new Error("Native runtime review expired during policy authorization.");
  }
  private async authorizeCandidate(authority: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority>, candidate: RemoteWorkerRuntimeRequestPreparation, signal?: AbortSignal, admitted = false) {
    const binding = candidate.approvalDraft.payload.nativeRuntime as Record<string, unknown>;
    if (authority.registryWorkspaceId !== binding.registryWorkspaceId || authority.assignmentId !== binding.assignmentId || authority.assignmentGeneration !== binding.assignmentGeneration)
      throw new Error("Native policy review belongs to another assignment.");
    signal?.throwIfAborted();
    const request = { ...authority, launch: candidate.request.launch, inventoryLimits: candidate.request.inventoryLimits,
      ...(candidate.request.fileStaging ? { fileStaging: candidate.request.fileStaging } : {}), discloseFilesToGateway: candidate.approvalDraft.payload.nativeFileDisclosure !== undefined, signal };
    if (admitted) {
      if (!this.policy) throw new Error("Native authorization requires its retained policy reservation.");
      await this.policy.authorizeAdmitted({ ...request, nonce: candidate.candidateExpectation.nonce, requestSha256: candidate.candidateExpectation.requestSha256 });
    } else await this.policy?.authorize(request);
    signal?.throwIfAborted();
  }
  private fileDisclosurePayload(command: RemoteWorkerRuntimeRequestPreparationInput, draft: ApprovalCreateInput,
    request: ReturnType<typeof normalizeWindowsRuntimeDispatch>, expected: ReturnType<typeof normalizeRemoteWorkerRuntimeResultExpectation>) {
    if (Boolean(command.discloseFilesToGateway) !== (draft.payload.nativeFileDisclosure !== undefined))
      throw new Error("Native file disclosure must be explicitly requested for operator review.");
    if (!command.discloseFilesToGateway) return {};
    const disclosure = normalizeRemoteWorkerNativeFileDisclosure(draft.payload.nativeFileDisclosure);
    if (disclosure.registryWorkspaceId !== command.registryWorkspaceId || disclosure.assignmentId !== command.assignmentId ||
        disclosure.assignmentGeneration !== command.assignmentGeneration || disclosure.nonce !== expected.nonce ||
        disclosure.requestSha256 !== expected.requestSha256 || disclosure.executionWorkspaceId !== draft.linkage?.workspaceId ||
        disclosure.fileStagingSha256 !== remoteWorkerNativeFileStagingSha256(request.fileStaging))
      throw new Error("Native file disclosure differs from its exact reviewed request and destination.");
    return { nativeFileDisclosure: disclosure };
  }
}
