import {
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  canonicalJsonString,
  normalizeRemoteWorkerInferenceApprovalResolutionReceipt,
  normalizeRemoteWorkerInferenceBudgetReservation,
  normalizeRemoteWorkerInferenceEffectiveRouteReceipt,
  normalizeRemoteWorkerInferenceGovernanceReceipt,
  normalizeRemoteWorkerInferenceOperationIdentifier,
  normalizeRemoteWorkerInferenceRequestSubmission,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerInferenceBudgetOperationSha256,
  remoteWorkerInferenceCanonicalSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceLeaseTokenSha256,
  remoteWorkerInferenceRequestSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  type RemoteWorkerInferenceApprovalResolutionReceipt,
  type RemoteWorkerInferenceBudgetOperationInput,
  type RemoteWorkerInferenceBudgetReservation,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerInferenceFrameRecord,
  RemoteWorkerInferenceRepository,
  RemoteWorkerInferenceRequestKey,
  RemoteWorkerInferenceRequestRecord,
} from "@goatcitadel/storage";
import type {
  RemoteWorkerInferenceDispatchOutcome,
  RemoteWorkerInferenceDispatchRequest,
  RemoteWorkerInferenceProviderResolution,
} from "./remote-worker-inference-llm-adapter.js";
import type { Awaitable, AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

/**
 * HX-503 assignment-bound inference service (production-dark).
 *
 * This owner intentionally has no route, scheduler, startup composition, or
 * live budget adapter. A future composition must supply a real server-owned
 * budget authority. Worker output bytes, routed-context reserves, and daily
 * USD settings are not accepted as budget authority here.
 */

export const REMOTE_WORKER_INFERENCE_REQUIRED_CLAIMS = ["worker_runtime", "gateway_inference"] as const;
export const REMOTE_WORKER_INFERENCE_RELEASE_REASONS = [
  "pre_dispatch_authority_lost",
  "governance_denied",
  "approval_rejected",
  "budget_revalidation_failed",
] as const;
export type RemoteWorkerInferenceReleaseReason = (typeof REMOTE_WORKER_INFERENCE_RELEASE_REASONS)[number];

type RemoteWorkerInferenceRepositoryMethod =
  | "inspectReplay"
  | "admitOrReplay"
  | "recordApprovalContinuation"
  | "recordBudgetReservation"
  | "blockBeforeDispatch"
  | "claimDispatch"
  | "appendOutputFrame"
  | "markDispatchUnknown"
  | "recoverExpiredDispatchUnknown"
  | "finalizeTerminal"
  | "markBudgetSettled"
  | "acknowledge"
  | "getRequest"
  | "listFramesAfter";

export type RemoteWorkerInferenceRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerInferenceRepository,
  RemoteWorkerInferenceRepositoryMethod
>;

export interface RemoteWorkerInferenceResolvedAuthority {
  readonly registryWorkspaceId: string;
  readonly executionWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly durableRunId: string;
  readonly taskId: string;
  readonly leaseRevision: number;
  readonly capabilityProfileSha256: string;
  readonly routedContextSha256: string;
  /** Authenticated server-resolved capability truth; never copied from request input. */
  readonly capabilityClaims: readonly string[];
}

export interface RemoteWorkerInferenceAuthorityPort {
  resolveActiveAuthority(input: {
    leaseTokenSha256: string;
  }): Awaitable<RemoteWorkerInferenceResolvedAuthority | undefined>;
}

export interface RemoteWorkerInferenceGovernanceRequest {
  readonly authority: RemoteWorkerInferenceResolvedAuthority;
  readonly submission: RemoteWorkerInferenceRequestSubmission;
  readonly approvalResolution?: RemoteWorkerInferenceApprovalResolutionReceipt;
}

export interface RemoteWorkerInferenceGovernancePort {
  evaluate(input: RemoteWorkerInferenceGovernanceRequest): Awaitable<RemoteWorkerInferenceGovernanceReceipt>;
}

export interface RemoteWorkerInferenceApprovalPort {
  /** Returns undefined while the approval owner still considers the receipt pending. */
  resolve(input: {
    readonly authority: RemoteWorkerInferenceResolvedAuthority;
    readonly pendingApprovalReceiptSha256: string;
    readonly requestSha256: string;
  }): Awaitable<RemoteWorkerInferenceApprovalResolutionReceipt | undefined>;
}

export interface RemoteWorkerInferenceBudgetReserveRequest {
  readonly authority: RemoteWorkerInferenceResolvedAuthority;
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly operation: RemoteWorkerInferenceBudgetOperationInput;
  readonly operationSha256: string;
}

export interface RemoteWorkerInferenceBudgetPort {
  /** Exact-idempotent reservation; undefined is a definitive fail-closed denial. */
  reserve(
    input: RemoteWorkerInferenceBudgetReserveRequest,
  ): Awaitable<RemoteWorkerInferenceBudgetReservation | undefined>;
  /** Settle only from canonical HX-306 event ids. */
  settle(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    usageEventIds: readonly string[];
  }): Awaitable<void>;
  /** Idempotent release of an unused exact reservation. */
  release(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    reason: RemoteWorkerInferenceReleaseReason;
  }): Awaitable<void>;
}

export interface RemoteWorkerInferenceRoutingPort {
  resolve(input: {
    authority: RemoteWorkerInferenceResolvedAuthority;
    governance: RemoteWorkerInferenceGovernanceReceipt;
  }): Awaitable<RemoteWorkerInferenceProviderResolution>;
}

export interface RemoteWorkerInferenceDispatchAdapter {
  dispatch(request: RemoteWorkerInferenceDispatchRequest): Promise<RemoteWorkerInferenceDispatchOutcome>;
}

export interface RemoteWorkerInferenceServiceOptions {
  readonly repository: RemoteWorkerInferenceRepositoryPort;
  readonly authority: RemoteWorkerInferenceAuthorityPort;
  readonly governance: RemoteWorkerInferenceGovernancePort;
  readonly approval: RemoteWorkerInferenceApprovalPort;
  readonly budget: RemoteWorkerInferenceBudgetPort;
  readonly routing: RemoteWorkerInferenceRoutingPort;
  readonly adapter: RemoteWorkerInferenceDispatchAdapter;
  /** Expected stable identity of the injected server-side budget owner. */
  readonly budgetOwnerId: string;
  readonly dispatchOwnerId: string;
  readonly clock: () => string;
  readonly operationIdFor?: (submission: RemoteWorkerInferenceRequestSubmission) => string;
  readonly dispatchGenerationFor?: (submission: RemoteWorkerInferenceRequestSubmission) => string;
}

export interface RemoteWorkerInferencePerformInput {
  readonly submission: RemoteWorkerInferenceRequestSubmission;
}

export type RemoteWorkerInferencePerformDisposition =
  | "delivered"
  | "failed"
  | "cancelled"
  | "dispatch_unknown"
  | "waiting_approval"
  | "blocked"
  | "lost_claim"
  | "replayed";

export interface RemoteWorkerInferencePerformOutcome {
  readonly disposition: RemoteWorkerInferencePerformDisposition;
  readonly request: RemoteWorkerInferenceRequestRecord;
  readonly frames: readonly RemoteWorkerInferenceFrameRecord[];
}

export class RemoteWorkerInferenceAccessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerInferenceAccessError";
  }
}

interface AllowedDecision {
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly resolution: RemoteWorkerInferenceProviderResolution;
  readonly route: RemoteWorkerInferenceEffectiveRouteReceipt;
  readonly operation: RemoteWorkerInferenceBudgetOperationInput;
  readonly operationSha256: string;
}

export class RemoteWorkerInferenceService {
  private readonly options: RemoteWorkerInferenceServiceOptions;

  public constructor(options: RemoteWorkerInferenceServiceOptions) {
    normalizeRemoteWorkerInferenceOperationIdentifier(options.budgetOwnerId, "budget owner id");
    normalizeRemoteWorkerInferenceOperationIdentifier(options.dispatchOwnerId, "dispatch owner id");
    this.options = options;
  }

  public async performInference(
    input: RemoteWorkerInferencePerformInput,
  ): Promise<RemoteWorkerInferencePerformOutcome> {
    const submission = normalizeRemoteWorkerInferenceRequestSubmission(input.submission);

    const leaseTokenSha256 = remoteWorkerInferenceLeaseTokenSha256(submission.leaseToken);
    const authority = await this.resolveAuthorityOrThrow(leaseTokenSha256);
    this.assertCapabilityClaims(authority.capabilityClaims);
    this.assertSubmissionAuthority(authority, submission, "admission");

    // Exact replay is checked before governance, routing, approval, or budget.
    const replay = await this.options.repository.inspectReplay(input.submission);
    if (replay) {
      this.assertStoredAuthority(authority, replay.request, "replay");
      return await this.resumeExisting(input.submission, submission, leaseTokenSha256, authority, replay.request);
    }

    const governance = normalizeRemoteWorkerInferenceGovernanceReceipt(
      await this.options.governance.evaluate({ authority, submission: input.submission }),
    );
    if (governance.decision !== "allowed") {
      const admission = await this.options.repository.admitOrReplay({
        submission: input.submission,
        ...authorityAdmission(authority),
        operationId: this.operationId(input.submission),
        dispatchGeneration: this.dispatchGeneration(input.submission),
        governance,
        admittedAt: this.options.clock(),
      });
      if (admission.disposition === "replayed") {
        this.assertStoredAuthority(authority, admission.request, "concurrent replay");
        return await this.resumeExisting(input.submission, submission, leaseTokenSha256, authority, admission.request);
      }
      return await this.finish(
        governance.decision === "denied" ? "blocked" : "waiting_approval",
        keyOf(admission.request),
      );
    }

    const allowed = await this.resolveAllowed(input.submission, authority, governance);
    const admission = await this.options.repository.admitOrReplay({
      submission: input.submission,
      ...authorityAdmission(authority),
      operationId: allowed.operation.operationId,
      dispatchGeneration: allowed.operation.dispatchGeneration,
      governance: allowed.governance,
      effectiveRoute: allowed.route,
      budgetOperation: allowed.operation,
      admittedAt: this.options.clock(),
    });
    if (admission.disposition === "replayed") {
      this.assertStoredAuthority(authority, admission.request, "concurrent replay");
      return await this.resumeExisting(input.submission, submission, leaseTokenSha256, authority, admission.request);
    }
    return await this.reserveRevalidateAndDispatch(
      input.submission,
      submission,
      leaseTokenSha256,
      admission.request,
      authority,
      allowed,
    );
  }

  /** Restart-safe settlement. It never invokes the provider. */
  public async reconcileBudgetSettlement(
    key: RemoteWorkerInferenceRequestKey,
  ): Promise<RemoteWorkerInferenceRequestRecord> {
    const request = await this.requireRequest(key);
    if (request.budgetAuthorityState === "settled") return request;
    if (request.budgetAuthorityState !== "settlement_pending") {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference request is not settlement-pending.");
    }
    const reservation = this.reservationFromRecord(request);
    const usageEventIds = this.usageEventIdsFromRecord(request);
    try {
      await this.options.budget.settle({ reservation, usageEventIds });
    } catch {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget settlement requires reconciliation.");
    }
    return await this.options.repository.markBudgetSettled(key, this.options.clock());
  }

  /** Restart-safe release for a blocked, never-dispatched reservation. */
  public async reconcileBudgetRelease(
    key: RemoteWorkerInferenceRequestKey,
    reason: RemoteWorkerInferenceReleaseReason = "pre_dispatch_authority_lost",
  ): Promise<RemoteWorkerInferenceRequestRecord> {
    assertReleaseReason(reason);
    const request = await this.requireRequest(key);
    if (request.budgetAuthorityState === "released") return request;
    if (request.state !== "blocked" || request.budgetAuthorityState !== "reserved") {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference request has no recoverable release.");
    }
    const reservation = this.reservationFromRecord(request);
    await this.options.budget.release({ reservation, reason });
    return await this.options.repository.blockBeforeDispatch(key, {
      reason,
      budgetReleased: true,
      now: this.options.clock(),
    });
  }

  public async readPendingFrames(input: {
    submission: Pick<
      RemoteWorkerInferenceRequestSubmission,
      "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "inferenceRequestId" | "attempt" | "leaseToken"
    >;
  }): Promise<readonly RemoteWorkerInferenceFrameRecord[]> {
    const authority = await this.resolveAuthorityOrThrow(
      remoteWorkerInferenceLeaseTokenSha256(input.submission.leaseToken),
    );
    this.assertCapabilityClaims(authority.capabilityClaims);
    this.assertKeyAuthority(authority, input.submission, "read");
    const key = keyFromParts(input.submission);
    const request = await this.requireRequest(key);
    this.assertStoredAuthority(authority, request, "read");
    return await this.options.repository.listFramesAfter(key, request.workerAcknowledgedThrough);
  }

  public async acknowledge(input: {
    submission: Pick<
      RemoteWorkerInferenceRequestSubmission,
      "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "inferenceRequestId" | "attempt" | "leaseToken"
    >;
    throughSequence: number;
  }): Promise<RemoteWorkerInferenceRequestRecord> {
    const authority = await this.resolveAuthorityOrThrow(
      remoteWorkerInferenceLeaseTokenSha256(input.submission.leaseToken),
    );
    this.assertCapabilityClaims(authority.capabilityClaims);
    this.assertKeyAuthority(authority, input.submission, "acknowledgement");
    const key = keyFromParts(input.submission);
    const request = await this.requireRequest(key);
    this.assertStoredAuthority(authority, request, "acknowledgement");
    return await this.options.repository.acknowledge(key, input.throughSequence, this.options.clock());
  }

  private async resumeExisting(
    submissionInput: RemoteWorkerInferenceRequestSubmission,
    submission: ReturnType<typeof normalizeRemoteWorkerInferenceRequestSubmission>,
    leaseTokenSha256: string,
    authority: RemoteWorkerInferenceResolvedAuthority,
    request: RemoteWorkerInferenceRequestRecord,
  ): Promise<RemoteWorkerInferencePerformOutcome> {
    const key = keyOf(request);
    if (request.budgetAuthorityState === "legacy_unverifiable") {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference legacy budget authority is unverifiable and cannot continue.",
      );
    }
    if (request.budgetAuthorityState === "settlement_pending") {
      await this.reconcileBudgetSettlement(key);
      return await this.finish("replayed", key);
    }
    if (request.state === "blocked" && request.budgetAuthorityState === "reserved") {
      await this.reconcileBudgetRelease(key, "pre_dispatch_authority_lost");
      return await this.finish("blocked", key);
    }
    if (request.state === "dispatch_claimed" || request.state === "streaming") {
      const recovered = await this.options.repository.recoverExpiredDispatchUnknown(key, this.options.clock());
      return await this.finish(recovered ? "dispatch_unknown" : "lost_claim", key);
    }
    if (request.state === "waiting_approval") {
      const pendingApprovalReceiptSha256 = request.approvalReceiptSha256;
      if (!pendingApprovalReceiptSha256) {
        throw new RemoteWorkerInferenceAccessError("Remote worker inference waiting request lacks approval authority.");
      }
      const rawApproval = await this.options.approval.resolve({
        authority,
        pendingApprovalReceiptSha256,
        requestSha256: request.requestSha256,
      });
      if (!rawApproval) return await this.finish("waiting_approval", key);
      const approval = normalizeRemoteWorkerInferenceApprovalResolutionReceipt(rawApproval);
      if (approval.pendingApprovalReceiptSha256 !== pendingApprovalReceiptSha256) {
        throw new RemoteWorkerInferenceAccessError(
          "Remote worker inference approval receipt does not bind the pending request.",
        );
      }
      if (
        Date.parse(approval.resolvedAt) < Date.parse(request.admittedAt) ||
        Date.parse(approval.resolvedAt) > Date.parse(this.options.clock())
      ) {
        throw new RemoteWorkerInferenceAccessError("Remote worker inference approval receipt is not temporally valid.");
      }
      if (approval.decision === "rejected") {
        await this.options.repository.blockBeforeDispatch(key, {
          reason: "approval_rejected",
          approvalResolution: approval,
          now: this.options.clock(),
        });
        return await this.finish("blocked", key);
      }

      const freshGovernance = normalizeRemoteWorkerInferenceGovernanceReceipt(
        await this.options.governance.evaluate({
          authority,
          submission: submissionInput,
          approvalResolution: approval,
        }),
      );
      if (freshGovernance.decision !== "allowed") {
        await this.options.repository.blockBeforeDispatch(key, {
          reason: `approval_continuation_${freshGovernance.decision}`,
          approvalResolution: approval,
          now: this.options.clock(),
        });
        return await this.finish("blocked", key);
      }
      const allowed = await this.resolveAllowed(submissionInput, authority, freshGovernance, request);
      const continued = await this.options.repository.recordApprovalContinuation({
        ...key,
        approvalResolution: approval,
        governance: allowed.governance,
        effectiveRoute: allowed.route,
        budgetOperation: allowed.operation,
        now: this.options.clock(),
      });
      if (!continued) return await this.finish("replayed", key);
      return await this.reserveRevalidateAndDispatch(
        submissionInput,
        submission,
        leaseTokenSha256,
        continued,
        authority,
        allowed,
        approval,
      );
    }

    if (request.state === "admitted" && ["reservation_pending", "reserved"].includes(request.budgetAuthorityState)) {
      const approval = this.approvalFromRecord(request);
      const freshGovernance = normalizeRemoteWorkerInferenceGovernanceReceipt(
        await this.options.governance.evaluate({
          authority,
          submission: submissionInput,
          ...(approval ? { approvalResolution: approval } : {}),
        }),
      );
      if (freshGovernance.decision !== "allowed") {
        await this.releaseOrBlock(key, request, `replay_governance_${freshGovernance.decision}`, "governance_denied");
        return await this.finish("blocked", key);
      }
      const allowed = await this.resolveAllowed(submissionInput, authority, freshGovernance, request);
      return await this.reserveRevalidateAndDispatch(
        submissionInput,
        submission,
        leaseTokenSha256,
        request,
        authority,
        allowed,
        approval,
      );
    }
    return await this.finish("replayed", key);
  }

  private async reserveRevalidateAndDispatch(
    submissionInput: RemoteWorkerInferenceRequestSubmission,
    submission: ReturnType<typeof normalizeRemoteWorkerInferenceRequestSubmission>,
    leaseTokenSha256: string,
    initialRequest: RemoteWorkerInferenceRequestRecord,
    authority: RemoteWorkerInferenceResolvedAuthority,
    allowed: AllowedDecision,
    approval?: RemoteWorkerInferenceApprovalResolutionReceipt,
  ): Promise<RemoteWorkerInferencePerformOutcome> {
    const key = keyOf(initialRequest);
    this.assertStoredOperation(initialRequest, allowed.operation, allowed.operationSha256);
    let request = initialRequest;
    let reservation: RemoteWorkerInferenceBudgetReservation;
    if (request.budgetAuthorityState === "reservation_pending") {
      let reserved: RemoteWorkerInferenceBudgetReservation | undefined;
      try {
        reserved = await this.options.budget.reserve({
          authority,
          governance: allowed.governance,
          operation: allowed.operation,
          operationSha256: allowed.operationSha256,
        });
      } catch {
        throw new RemoteWorkerInferenceAccessError(
          "Remote worker inference budget reservation outcome is unavailable.",
        );
      }
      if (!reserved) {
        await this.options.repository.blockBeforeDispatch(key, {
          reason: "budget_denied",
          now: this.options.clock(),
        });
        return await this.finish("blocked", key);
      }
      reservation = this.assertReservation(reserved, allowed.operation, allowed.operationSha256);
      request = await this.options.repository.recordBudgetReservation(key, reservation, this.options.clock());
    } else if (request.budgetAuthorityState === "reserved") {
      reservation = this.reservationFromRecord(request);
      this.assertReservation(reservation, allowed.operation, allowed.operationSha256);
    } else {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference request has no dispatchable budget authority.",
      );
    }

    let revalidated: RemoteWorkerInferenceResolvedAuthority;
    let revalidatedGovernance: RemoteWorkerInferenceGovernanceReceipt;
    let revalidatedResolution: RemoteWorkerInferenceProviderResolution;
    try {
      revalidated = await this.resolveAuthorityOrThrow(leaseTokenSha256);
      this.assertSubmissionAuthority(revalidated, submission, "dispatch");
      this.assertStoredAuthority(revalidated, request, "dispatch");
      revalidatedGovernance = normalizeRemoteWorkerInferenceGovernanceReceipt(
        await this.options.governance.evaluate({
          authority: revalidated,
          submission: submissionInput,
          ...(approval ? { approvalResolution: approval } : {}),
        }),
      );
      if (revalidatedGovernance.decision !== "allowed") {
        throw new RemoteWorkerInferenceAccessError(
          `Remote worker inference governance changed to ${revalidatedGovernance.decision} before dispatch.`,
        );
      }
      const revalidatedAllowed = await this.resolveAllowed(
        submissionInput,
        revalidated,
        revalidatedGovernance,
        request,
      );
      this.assertStoredOperation(request, revalidatedAllowed.operation, revalidatedAllowed.operationSha256);
      revalidatedResolution = revalidatedAllowed.resolution;
    } catch {
      await this.releaseOrBlock(key, request, "pre_dispatch_authority_lost", "pre_dispatch_authority_lost");
      throw new RemoteWorkerInferenceAccessError("Remote worker inference pre-dispatch authority revalidation failed.");
    }

    const claimExpiry = earlierTimestamp(revalidatedGovernance.expiresAt, reservation.expiresAt);
    const claimed = await this.options.repository.claimDispatch({
      ...key,
      dispatchClaimOwner: this.options.dispatchOwnerId,
      effectiveProviderId: revalidatedResolution.providerId,
      effectiveModelId: revalidatedResolution.modelId,
      effectiveRouteSha256: request.effectiveRouteSha256,
      dispatchLeaseExpiresAt: claimExpiry,
      now: this.options.clock(),
    });
    if (!claimed) return await this.finish("lost_claim", key);

    let outcome: RemoteWorkerInferenceDispatchOutcome;
    try {
      outcome = await this.options.adapter.dispatch({
        attribution: {
          callKind: "delegation_worker",
          operationId: request.operationId,
          dispatchGeneration: request.dispatchGeneration,
          workspaceId: revalidated.executionWorkspaceId,
          sessionId: revalidated.sessionId,
          turnId: revalidated.turnId,
          durableRunId: revalidated.durableRunId,
          taskId: revalidated.taskId,
          workerId: revalidated.workerId,
          contextIntentHash: revalidated.routedContextSha256,
        },
        resolution: revalidatedResolution,
        messages: submission.messages,
        requestedOutputTokenCap: submission.outputTokenCeiling,
        effectiveOutputTokenCap: allowed.operation.outputTokenCeiling,
        reasoningTokenCeiling: allowed.operation.reasoningTokenCeiling,
        temperatureMilli: submission.temperatureMilli,
      });
    } catch {
      await this.options.repository.markDispatchUnknown(key, {
        dispatchClaimOwner: this.options.dispatchOwnerId,
        now: this.options.clock(),
      });
      return await this.finish("dispatch_unknown", key);
    }

    try {
      for (const text of outcome.chunks) {
        if (text.length === 0) continue;
        await this.options.repository.appendOutputFrame({
          ...key,
          dispatchClaimOwner: this.options.dispatchOwnerId,
          text,
          now: this.options.clock(),
        });
      }
      if (outcome.terminalState === "dispatch_unknown") {
        await this.options.repository.markDispatchUnknown(key, {
          dispatchClaimOwner: this.options.dispatchOwnerId,
          usageEventIds: outcome.usageEventIds,
          now: this.options.clock(),
        });
        return await this.finish("dispatch_unknown", key);
      }
      await this.options.repository.finalizeTerminal({
        ...key,
        dispatchClaimOwner: this.options.dispatchOwnerId,
        terminalState: outcome.terminalState,
        usageEventIds: outcome.usageEventIds,
        now: this.options.clock(),
      });
    } catch (error) {
      const current = await this.requireRequest(key);
      if (current.state === "dispatch_claimed" || current.state === "streaming") {
        await this.options.repository.markDispatchUnknown(key, {
          dispatchClaimOwner: this.options.dispatchOwnerId,
          usageEventIds: outcome.usageEventIds,
          now: this.options.clock(),
        });
      }
      throw error;
    }

    await this.reconcileBudgetSettlement(key);
    return await this.finish(dispositionFor(outcome.terminalState), key);
  }

  private async resolveAllowed(
    submission: RemoteWorkerInferenceRequestSubmission,
    authority: RemoteWorkerInferenceResolvedAuthority,
    governanceInput: RemoteWorkerInferenceGovernanceReceipt,
    existing?: RemoteWorkerInferenceRequestRecord,
  ): Promise<AllowedDecision> {
    const governance = normalizeRemoteWorkerInferenceGovernanceReceipt(governanceInput);
    if (governance.decision !== "allowed") {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference requires allowed governance before routing.");
    }
    if (Date.parse(governance.expiresAt) <= Date.parse(this.options.clock())) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference governance receipt is expired.");
    }
    const resolution = await this.options.routing.resolve({ authority, governance });
    const route = routeReceiptFor(resolution);
    const routeSha256 = remoteWorkerInferenceEffectiveRouteSha256(route);
    if (routeSha256 !== governance.effectiveRouteSha256) {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference runtime route does not match the governance route digest.",
      );
    }
    if (existing?.effectiveRouteJson && canonicalJsonString(route) !== existing.effectiveRouteJson) {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference effective route drifted from stored evidence.",
      );
    }
    const operation = this.budgetOperation(submission, authority, governance, routeSha256, existing);
    return {
      governance,
      resolution,
      route,
      operation,
      operationSha256: remoteWorkerInferenceBudgetOperationSha256(operation),
    };
  }

  private budgetOperation(
    submission: RemoteWorkerInferenceRequestSubmission,
    authority: RemoteWorkerInferenceResolvedAuthority,
    governance: RemoteWorkerInferenceGovernanceReceipt,
    effectiveRouteSha256: string,
    existing?: RemoteWorkerInferenceRequestRecord,
  ): RemoteWorkerInferenceBudgetOperationInput {
    return {
      operationId: existing?.operationId ?? this.operationId(submission),
      dispatchGeneration: existing?.dispatchGeneration ?? this.dispatchGeneration(submission),
      requestSha256: remoteWorkerInferenceRequestSha256(submission),
      effectiveRouteSha256,
      registryWorkspaceId: authority.registryWorkspaceId,
      executionWorkspaceId: authority.executionWorkspaceId,
      assignmentId: authority.assignmentId,
      assignmentGeneration: authority.assignmentGeneration,
      workerId: authority.workerId,
      workerGeneration: authority.workerGeneration,
      admittedLeaseRevision: existing?.admittedLeaseRevision ?? authority.leaseRevision,
      sessionId: authority.sessionId,
      turnId: authority.turnId,
      durableRunId: authority.durableRunId,
      taskId: authority.taskId,
      capabilityProfileSha256: authority.capabilityProfileSha256,
      routedContextSha256: authority.routedContextSha256,
      outputTokenCeiling: Math.min(submission.outputTokenCeiling, governance.outputTokenCeiling),
      reasoningTokenCeiling: Math.min(submission.reasoningTokenCeiling, governance.reasoningTokenCeiling),
    };
  }

  private assertReservation(
    reservationInput: RemoteWorkerInferenceBudgetReservation,
    operation: RemoteWorkerInferenceBudgetOperationInput,
    operationSha256: string,
  ): RemoteWorkerInferenceBudgetReservation {
    const reservation = normalizeRemoteWorkerInferenceBudgetReservation(reservationInput);
    if (
      reservation.operationId !== operation.operationId ||
      reservation.budgetOwnerId !== this.options.budgetOwnerId ||
      reservation.operationSha256 !== operationSha256 ||
      reservation.requestSha256 !== operation.requestSha256 ||
      reservation.effectiveRouteSha256 !== operation.effectiveRouteSha256 ||
      reservation.reservedOutputTokens !== operation.outputTokenCeiling ||
      reservation.reservedReasoningTokens !== operation.reasoningTokenCeiling ||
      Date.parse(reservation.expiresAt) <= Date.parse(this.options.clock())
    ) {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference budget reservation does not exactly bind the operation.",
      );
    }
    return reservation;
  }

  private async releaseOrBlock(
    key: RemoteWorkerInferenceRequestKey,
    request: RemoteWorkerInferenceRequestRecord,
    blockReason: string,
    releaseReason: RemoteWorkerInferenceReleaseReason,
  ): Promise<void> {
    assertReleaseReason(releaseReason);
    if (request.budgetAuthorityState !== "reserved") {
      await this.options.repository.blockBeforeDispatch(key, { reason: blockReason, now: this.options.clock() });
      return;
    }
    const reservation = this.reservationFromRecord(request);
    try {
      await this.options.budget.release({ reservation, reason: releaseReason });
      await this.options.repository.blockBeforeDispatch(key, {
        reason: blockReason,
        budgetReleased: true,
        now: this.options.clock(),
      });
    } catch {
      await this.options.repository.blockBeforeDispatch(key, { reason: blockReason, now: this.options.clock() });
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget release requires reconciliation.");
    }
  }

  private reservationFromRecord(request: RemoteWorkerInferenceRequestRecord): RemoteWorkerInferenceBudgetReservation {
    if (!request.budgetReservationJson || !request.budgetReservationSha256) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget reservation evidence is incomplete.");
    }
    const reservation = normalizeRemoteWorkerInferenceBudgetReservation(
      JSON.parse(request.budgetReservationJson) as RemoteWorkerInferenceBudgetReservation,
    );
    if (reservation.budgetOwnerId !== this.options.budgetOwnerId) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget owner identity drifted.");
    }
    if (remoteWorkerInferenceCanonicalSha256(reservation) !== request.budgetReservationSha256) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget reservation evidence hash drifted.");
    }
    return reservation;
  }

  private usageEventIdsFromRecord(request: RemoteWorkerInferenceRequestRecord): readonly string[] {
    if (!request.usageEventIdsJson || !request.usageEventIdsSha256) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference settlement lacks HX-306 event ids.");
    }
    const parsed = JSON.parse(request.usageEventIdsJson) as readonly string[];
    const ids = normalizeRemoteWorkerInferenceUsageEventIds(parsed);
    if (remoteWorkerInferenceUsageEventIdsSha256(ids) !== request.usageEventIdsSha256) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference HX-306 event id evidence hash drifted.");
    }
    return ids;
  }

  private approvalFromRecord(
    request: RemoteWorkerInferenceRequestRecord,
  ): RemoteWorkerInferenceApprovalResolutionReceipt | undefined {
    if (!request.approvalResolutionJson) return undefined;
    const approval = normalizeRemoteWorkerInferenceApprovalResolutionReceipt(
      JSON.parse(request.approvalResolutionJson) as RemoteWorkerInferenceApprovalResolutionReceipt,
    );
    if (
      !request.approvalResolutionSha256 ||
      remoteWorkerInferenceCanonicalSha256(approval) !== request.approvalResolutionSha256
    ) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference approval resolution evidence hash drifted.");
    }
    return approval;
  }

  private assertStoredOperation(
    request: RemoteWorkerInferenceRequestRecord,
    operation: RemoteWorkerInferenceBudgetOperationInput,
    operationSha256: string,
  ): void {
    if (
      request.budgetOperationId !== operation.operationId ||
      request.budgetOperationSha256 !== operationSha256 ||
      !request.budgetOperationJson ||
      remoteWorkerInferenceCanonicalSha256(JSON.parse(request.budgetOperationJson)) !== operationSha256
    ) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget operation identity drifted.");
    }
  }

  private assertCapabilityClaims(claims: readonly string[]): void {
    const present = new Set(claims);
    for (const required of REMOTE_WORKER_INFERENCE_REQUIRED_CLAIMS) {
      if (!present.has(required)) {
        throw new RemoteWorkerInferenceAccessError(
          `Remote worker inference requires the ${required} capability claim.`,
        );
      }
    }
  }

  private async resolveAuthorityOrThrow(leaseTokenSha256: string): Promise<RemoteWorkerInferenceResolvedAuthority> {
    let authority: RemoteWorkerInferenceResolvedAuthority | undefined;
    try {
      authority = await this.options.authority.resolveActiveAuthority({ leaseTokenSha256 });
    } catch {
      throw new RemoteWorkerInferenceAccessError(
        "Remote worker inference authority is cancelled, terminal, or unavailable.",
      );
    }
    if (!authority) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference lease is unknown, stale, or expired.");
    }
    this.assertCapabilityClaims(authority.capabilityClaims);
    return authority;
  }

  private assertSubmissionAuthority(
    authority: RemoteWorkerInferenceResolvedAuthority,
    submission: ReturnType<typeof normalizeRemoteWorkerInferenceRequestSubmission>,
    phase: string,
  ): void {
    this.assertKeyAuthority(authority, submission, phase);
    if (authority.routedContextSha256 !== submission.contextSha256) {
      throw new RemoteWorkerInferenceAccessError(`Remote worker inference routed-context hash drifted at ${phase}.`);
    }
  }

  private assertKeyAuthority(
    authority: RemoteWorkerInferenceResolvedAuthority,
    submission: Pick<
      RemoteWorkerInferenceRequestSubmission,
      "registryWorkspaceId" | "assignmentId" | "assignmentGeneration"
    >,
    phase: string,
  ): void {
    if (
      authority.registryWorkspaceId !== submission.registryWorkspaceId ||
      authority.assignmentId !== submission.assignmentId ||
      authority.assignmentGeneration !== submission.assignmentGeneration
    ) {
      throw new RemoteWorkerInferenceAccessError(
        `Remote worker inference lease does not bind the request at ${phase}.`,
      );
    }
  }

  private assertStoredAuthority(
    authority: RemoteWorkerInferenceResolvedAuthority,
    request: RemoteWorkerInferenceRequestRecord,
    phase: string,
  ): void {
    if (
      request.executionWorkspaceId === undefined ||
      request.durableRunId === undefined ||
      request.taskId === undefined ||
      request.admittedLeaseRevision === undefined ||
      authority.registryWorkspaceId !== request.registryWorkspaceId ||
      authority.executionWorkspaceId !== request.executionWorkspaceId ||
      authority.assignmentId !== request.assignmentId ||
      authority.assignmentGeneration !== request.assignmentGeneration ||
      authority.workerId !== request.workerId ||
      authority.workerGeneration !== request.workerGeneration ||
      authority.sessionId !== request.sessionId ||
      authority.turnId !== request.turnId ||
      authority.durableRunId !== request.durableRunId ||
      authority.taskId !== request.taskId ||
      authority.leaseRevision < request.admittedLeaseRevision ||
      authority.capabilityProfileSha256 !== request.capabilityProfileSha256 ||
      authority.routedContextSha256 !== request.routedContextSha256
    ) {
      throw new RemoteWorkerInferenceAccessError(`Remote worker inference stored authority drifted at ${phase}.`);
    }
  }

  private async finish(
    disposition: RemoteWorkerInferencePerformDisposition,
    key: RemoteWorkerInferenceRequestKey,
  ): Promise<RemoteWorkerInferencePerformOutcome> {
    const request = await this.requireRequest(key);
    return { disposition, request, frames: await this.options.repository.listFramesAfter(key, 0) };
  }

  private async requireRequest(key: RemoteWorkerInferenceRequestKey): Promise<RemoteWorkerInferenceRequestRecord> {
    const request = await this.options.repository.getRequest(key);
    if (!request) throw new RemoteWorkerInferenceAccessError("Remote worker inference request not found.");
    return request;
  }

  private operationId(submission: RemoteWorkerInferenceRequestSubmission): string {
    return (
      this.options.operationIdFor?.(submission) ??
      `rw-inference:${submission.registryWorkspaceId}:${submission.assignmentId}:${submission.assignmentGeneration}:${submission.inferenceRequestId}`
    );
  }

  private dispatchGeneration(submission: RemoteWorkerInferenceRequestSubmission): string {
    return this.options.dispatchGenerationFor?.(submission) ?? `${this.operationId(submission)}#${submission.attempt}`;
  }
}

function routeReceiptFor(
  resolution: RemoteWorkerInferenceProviderResolution,
): RemoteWorkerInferenceEffectiveRouteReceipt {
  return normalizeRemoteWorkerInferenceEffectiveRouteReceipt({
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
    providerId: resolution.providerId,
    modelId: resolution.modelId,
    apiStyle: resolution.apiStyle,
    ...(resolution.configuredContextWindowTokens === undefined
      ? {}
      : { configuredContextWindowTokens: resolution.configuredContextWindowTokens }),
    credentialType: resolution.credential.credentialType,
    usagePool: resolution.credential.usagePool,
    credentialSource: resolution.credential.credentialSource,
    ...(resolution.credential.credentialConfigFingerprint === undefined
      ? {}
      : { credentialConfigFingerprint: resolution.credential.credentialConfigFingerprint }),
    ...(resolution.pricing?.catalogVersion === undefined
      ? {}
      : { pricingCatalogVersion: resolution.pricing.catalogVersion }),
    ...(resolution.pricing?.catalogHash === undefined ? {} : { pricingCatalogHash: resolution.pricing.catalogHash }),
    ...(resolution.pricing?.inputRateUsdPerMillion === undefined
      ? {}
      : { inputRateUsdPerMillion: resolution.pricing.inputRateUsdPerMillion }),
    ...(resolution.pricing?.outputRateUsdPerMillion === undefined
      ? {}
      : { outputRateUsdPerMillion: resolution.pricing.outputRateUsdPerMillion }),
    ...(resolution.pricing?.cachedInputRateUsdPerMillion === undefined
      ? {}
      : { cachedInputRateUsdPerMillion: resolution.pricing.cachedInputRateUsdPerMillion }),
  });
}

function authorityAdmission(authority: RemoteWorkerInferenceResolvedAuthority) {
  return {
    workerId: authority.workerId,
    workerGeneration: authority.workerGeneration,
    executionWorkspaceId: authority.executionWorkspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    durableRunId: authority.durableRunId,
    taskId: authority.taskId,
    admittedLeaseRevision: authority.leaseRevision,
    capabilityProfileSha256: authority.capabilityProfileSha256,
    routedContextSha256: authority.routedContextSha256,
  } as const;
}

function earlierTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function assertReleaseReason(value: string): asserts value is RemoteWorkerInferenceReleaseReason {
  if (!(REMOTE_WORKER_INFERENCE_RELEASE_REASONS as readonly string[]).includes(value)) {
    throw new RemoteWorkerInferenceAccessError("Remote worker inference budget release reason is unsupported.");
  }
}

function dispositionFor(
  terminalState: RemoteWorkerInferenceDispatchOutcome["terminalState"],
): RemoteWorkerInferencePerformDisposition {
  if (terminalState === "completed") return "delivered";
  if (terminalState === "cancelled") return "cancelled";
  if (terminalState === "dispatch_unknown") return "dispatch_unknown";
  return "failed";
}

function keyOf(request: RemoteWorkerInferenceRequestRecord): RemoteWorkerInferenceRequestKey {
  return {
    registryWorkspaceId: request.registryWorkspaceId,
    assignmentId: request.assignmentId,
    assignmentGeneration: request.assignmentGeneration,
    inferenceRequestId: request.inferenceRequestId,
    attempt: request.attempt,
  };
}

function keyFromParts(parts: {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  inferenceRequestId: string;
  attempt: number;
}): RemoteWorkerInferenceRequestKey {
  return {
    registryWorkspaceId: parts.registryWorkspaceId,
    assignmentId: parts.assignmentId,
    assignmentGeneration: parts.assignmentGeneration,
    inferenceRequestId: parts.inferenceRequestId,
    attempt: parts.attempt,
  };
}
