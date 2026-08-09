/* eslint-disable max-lines -- HX-503 cross-dialect inference lifecycle, atomic dispatch, and recovery invariants stay in one audited repository boundary. */
import {
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS,
  canonicalJsonString,
  normalizeRemoteWorkerInferenceApprovalResolutionReceipt,
  normalizeRemoteWorkerInferenceAuthorizedSubmission,
  normalizeRemoteWorkerInferenceBudgetReservation,
  normalizeRemoteWorkerInferenceEffectiveRouteReceipt,
  normalizeRemoteWorkerInferenceFramePayload,
  normalizeRemoteWorkerInferenceGovernanceReceipt,
  normalizeRemoteWorkerInferenceOperationIdentifier,
  normalizeRemoteWorkerInferenceReleaseReason,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerInferenceBudgetOperationMaterial,
  remoteWorkerInferenceBudgetOperationSha256,
  remoteWorkerInferenceCanonicalRequestBody,
  remoteWorkerInferenceCanonicalSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceRequestSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  type RemoteWorkerInferenceApprovalResolutionReceipt,
  type RemoteWorkerInferenceAuthorizedSubmission,
  type RemoteWorkerInferenceBudgetAuthorityState,
  type RemoteWorkerInferenceBudgetOperationInput,
  type RemoteWorkerInferenceBudgetReservation,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
  type RemoteWorkerInferenceFrameKind,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceReleaseReason,
  type RemoteWorkerInferenceState,
  type RemoteWorkerInferenceTerminalState,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

/**
 * HX-503 assignment-bound inference request owner (production-dark).
 *
 * Persists the immutable assignment/worker/generation/request/hash bindings,
 * the canonical bounded request body, the stable HX-306 operation/generation
 * identity, the one-winner dispatch claim and database lease, secret-free
 * governance receipts, the effective route, HX-306 event references, output
 * counters, the worker acknowledgement watermark, the terminal receipt, and the
 * accounting disposition. It never stores a raw assignment lease or a provider
 * credential. The append-only outbox schema carries bounded provider-output
 * text, but has no fields for raw provider errors, headers, response bodies,
 * private reasoning, or server credential material; model-authored text is not
 * claimed to be secret-free.
 *
 * Every mutation runs in an immediate transaction. The database independently
 * enforces immutable bindings, terminal immutability (only the monotonic
 * acknowledgement watermark advances), the append-only hash-chained outbox, and
 * the one-winner dispatch claim.
 */

export interface RemoteWorkerInferenceAdmissionInput {
  readonly submission: RemoteWorkerInferenceAuthorizedSubmission;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly executionWorkspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly durableRunId: string;
  readonly taskId: string;
  readonly admittedLeaseRevision: number;
  readonly capabilityProfileSha256: string;
  readonly routedContextSha256: string;
  readonly operationId: string;
  readonly dispatchGeneration: string;
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly effectiveRoute?: RemoteWorkerInferenceEffectiveRouteReceipt;
  readonly budgetOperation?: RemoteWorkerInferenceBudgetOperationInput;
  readonly admittedAt: string;
}

export type RemoteWorkerInferenceAdmissionDisposition = "created" | "replayed";

export interface RemoteWorkerInferenceAdmissionOutcome {
  readonly disposition: RemoteWorkerInferenceAdmissionDisposition;
  readonly request: RemoteWorkerInferenceRequestRecord;
}

export interface RemoteWorkerInferenceDispatchClaimInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly dispatchClaimOwner: string;
  readonly effectiveProviderId: string;
  readonly effectiveModelId: string;
  readonly effectiveRouteSha256: string;
  readonly dispatchLeaseExpiresAt: string;
  readonly now: string;
}

export interface RemoteWorkerInferenceApprovalContinuationInput extends RemoteWorkerInferenceRequestKey {
  readonly approvalResolution: RemoteWorkerInferenceApprovalResolutionReceipt;
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly effectiveRoute: RemoteWorkerInferenceEffectiveRouteReceipt;
  readonly budgetOperation: RemoteWorkerInferenceBudgetOperationInput;
  readonly now: string;
}

export interface RemoteWorkerInferenceFrameAppendInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly dispatchClaimOwner: string;
  readonly text: string;
  readonly now: string;
}

export interface RemoteWorkerInferenceFinalizeInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly dispatchClaimOwner: string;
  readonly terminalState: RemoteWorkerInferenceTerminalState;
  readonly usageEventIds: readonly string[];
  readonly now: string;
}

export interface RemoteWorkerInferenceRequestKey {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
}

export interface RemoteWorkerInferenceRequestRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly executionWorkspaceId?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly durableRunId?: string;
  readonly taskId?: string;
  readonly admittedLeaseRevision?: number;
  readonly idempotencyKey: string;
  readonly requestBodyJson: string;
  readonly requestSha256: string;
  readonly inputSha256: string;
  readonly contextSha256: string;
  readonly modelIntentSha256: string;
  readonly capabilityProfileSha256: string;
  readonly routedContextSha256: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly temperatureMilli: number;
  readonly operationId: string;
  readonly dispatchGeneration: string;
  readonly state: RemoteWorkerInferenceState;
  readonly governanceDecision: RemoteWorkerInferenceGovernanceReceipt["decision"];
  readonly effectiveRouteSha256: string;
  readonly policyRevision: number;
  readonly policySha256: string;
  readonly approvalReceiptSha256?: string;
  readonly governanceOutputTokenCeiling: number;
  readonly governanceReasoningTokenCeiling: number;
  readonly governanceExpiresAt: string;
  readonly effectiveRouteJson?: string;
  readonly approvalResolutionJson?: string;
  readonly approvalResolutionSha256?: string;
  readonly approvalResolvedAt?: string;
  readonly continuationGovernanceJson?: string;
  readonly continuationGovernanceSha256?: string;
  readonly continuationGovernanceExpiresAt?: string;
  readonly budgetAuthorityState: RemoteWorkerInferenceBudgetAuthorityState;
  readonly budgetOperationId?: string;
  readonly budgetOperationJson?: string;
  readonly budgetOperationSha256?: string;
  readonly budgetReservationId?: string;
  readonly budgetReservationJson?: string;
  readonly budgetReservationSha256?: string;
  readonly budgetReservationExpiresAt?: string;
  readonly effectiveProviderId?: string;
  readonly effectiveModelId?: string;
  readonly dispatchClaimOwner?: string;
  readonly dispatchClaimedAt?: string;
  readonly dispatchLeaseExpiresAt?: string;
  readonly usageIntentEventId?: string;
  readonly usageTerminalEventId?: string;
  readonly usageEventIdsJson?: string;
  readonly usageEventIdsSha256?: string;
  readonly outputFrameCount: number;
  readonly outputCharCount: number;
  readonly workerAcknowledgedThrough: number;
  readonly terminalFrameSequence?: number;
  readonly terminalSha256?: string;
  readonly accountingDisposition?: "delegated" | "settled" | "unknown";
  readonly budgetSettledAt?: string;
  readonly budgetReleasedAt?: string;
  readonly budgetReleaseReason?: RemoteWorkerInferenceReleaseReason;
  readonly budgetReleaseRequestedAt?: string;
  readonly blockReason?: string;
  readonly admittedAt: string;
  readonly updatedAt: string;
}

export interface RemoteWorkerInferenceFrameRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly frameSequence: number;
  readonly frameKind: RemoteWorkerInferenceFrameKind;
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly previousFrameSha256: string;
  readonly frameSha256: string;
  readonly effectiveRouteSha256: string;
  readonly usageEventId?: string;
  readonly frameCharCount: number;
  readonly createdAt: string;
}

export interface RemoteWorkerInferenceFrameAppendOutcome {
  readonly frame: RemoteWorkerInferenceFrameRecord;
  readonly request: RemoteWorkerInferenceRequestRecord;
}

export class RemoteWorkerInferenceConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerInferenceConflictError";
  }
}

export class RemoteWorkerInferenceRepository {
  public constructor(private readonly db: DatabaseClient) {}

  /** Exact replay lookup with no governance, route, or budget side effect. */
  public inspectReplay(
    submissionInput: RemoteWorkerInferenceAuthorizedSubmission,
  ): RemoteWorkerInferenceAdmissionOutcome | undefined {
    const submission = normalizeRemoteWorkerInferenceAuthorizedSubmission(submissionInput);
    const replay = this.findByIdempotency(submission.registryWorkspaceId, submission.idempotencyKey);
    if (!replay) return undefined;
    if (replay.request_sha256 !== remoteWorkerInferenceRequestSha256(submissionInput)) {
      throw new RemoteWorkerInferenceConflictError(
        "Remote worker inference request replay does not match the stored canonical bytes.",
      );
    }
    return { disposition: "replayed", request: mapRequest(replay) };
  }

  /**
   * Boundary 3: insert or exactly replay the request. A reused idempotency key
   * with identical canonical bytes returns the existing request; changed bytes
   * conflict.
   */
  public admitOrReplay(input: RemoteWorkerInferenceAdmissionInput): RemoteWorkerInferenceAdmissionOutcome {
    const submission = normalizeRemoteWorkerInferenceAuthorizedSubmission(input.submission);
    const governance = normalizeRemoteWorkerInferenceGovernanceReceipt(input.governance);
    const requestSha256 = remoteWorkerInferenceRequestSha256(input.submission);
    const bodyJson = canonicalJsonString(remoteWorkerInferenceCanonicalRequestBody(input.submission));
    const state = admissionState(governance.decision);
    const budgetAuthorityState: RemoteWorkerInferenceBudgetAuthorityState =
      governance.decision === "allowed" ? "reservation_pending" : "not_required";
    const effectiveRoute =
      input.effectiveRoute === undefined
        ? undefined
        : normalizeRemoteWorkerInferenceEffectiveRouteReceipt(input.effectiveRoute);
    const budgetOperationMaterial =
      input.budgetOperation === undefined
        ? undefined
        : remoteWorkerInferenceBudgetOperationMaterial(input.budgetOperation);
    const budgetOperationSha256 =
      input.budgetOperation === undefined
        ? undefined
        : remoteWorkerInferenceBudgetOperationSha256(input.budgetOperation);
    if (governance.decision === "allowed") {
      if (!effectiveRoute || !budgetOperationMaterial || !budgetOperationSha256 || !input.budgetOperation) {
        throw new TypeError(
          "Allowed remote worker inference admission requires exact route and budget operation evidence.",
        );
      }
      if (remoteWorkerInferenceEffectiveRouteSha256(effectiveRoute) !== governance.effectiveRouteSha256) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference route receipt does not match the governance route digest.",
        );
      }
      if (
        input.budgetOperation.requestSha256 !== requestSha256 ||
        input.budgetOperation.effectiveRouteSha256 !== governance.effectiveRouteSha256 ||
        input.budgetOperation.operationId !== input.operationId ||
        input.budgetOperation.dispatchGeneration !== input.dispatchGeneration ||
        input.budgetOperation.registryWorkspaceId !== submission.registryWorkspaceId ||
        input.budgetOperation.executionWorkspaceId !== input.executionWorkspaceId ||
        input.budgetOperation.assignmentId !== submission.assignmentId ||
        input.budgetOperation.assignmentGeneration !== submission.assignmentGeneration ||
        input.budgetOperation.workerId !== input.workerId ||
        input.budgetOperation.workerGeneration !== input.workerGeneration ||
        input.budgetOperation.admittedLeaseRevision !== input.admittedLeaseRevision ||
        input.budgetOperation.sessionId !== input.sessionId ||
        input.budgetOperation.turnId !== input.turnId ||
        input.budgetOperation.durableRunId !== input.durableRunId ||
        input.budgetOperation.taskId !== input.taskId ||
        input.budgetOperation.capabilityProfileSha256 !== input.capabilityProfileSha256 ||
        input.budgetOperation.routedContextSha256 !== input.routedContextSha256 ||
        input.budgetOperation.outputTokenCeiling !==
          Math.min(submission.outputTokenCeiling, governance.outputTokenCeiling) ||
        input.budgetOperation.reasoningTokenCeiling !==
          Math.min(submission.reasoningTokenCeiling, governance.reasoningTokenCeiling)
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference budget operation does not bind the admitted request and route.",
        );
      }
    } else if (effectiveRoute || budgetOperationMaterial || budgetOperationSha256) {
      throw new TypeError("Denied or waiting remote worker inference admission cannot reserve budget authority.");
    }
    return this.db.transaction("immediate", () => {
      const replay = this.findByIdempotency(submission.registryWorkspaceId, submission.idempotencyKey);
      if (replay) {
        if (replay.request_sha256 !== requestSha256) {
          throw new RemoteWorkerInferenceConflictError(
            "Remote worker inference request replay does not match the stored canonical bytes.",
          );
        }
        return { disposition: "replayed", request: mapRequest(replay) };
      }
      this.insertStmt().run({
        registryWorkspaceId: submission.registryWorkspaceId,
        assignmentId: submission.assignmentId,
        assignmentGeneration: submission.assignmentGeneration,
        inferenceRequestId: submission.inferenceRequestId,
        attempt: submission.attempt,
        workerId: assertBounded(input.workerId, "workerId"),
        workerGeneration: assertPositive(input.workerGeneration, "workerGeneration"),
        executionWorkspaceId: assertBounded(input.executionWorkspaceId, "executionWorkspaceId"),
        sessionId: assertBounded(input.sessionId, "sessionId"),
        turnId: assertBounded(input.turnId, "turnId"),
        durableRunId: assertBounded(input.durableRunId, "durableRunId"),
        taskId: assertBounded(input.taskId, "taskId"),
        admittedLeaseRevision: assertPositive(input.admittedLeaseRevision, "admittedLeaseRevision"),
        idempotencyKey: submission.idempotencyKey,
        requestBodyJson: bodyJson,
        requestSha256,
        inputSha256: submission.inputSha256,
        contextSha256: submission.contextSha256,
        modelIntentSha256: submission.modelIntentSha256,
        capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, "capabilityProfileSha256"),
        routedContextSha256: assertDigest(input.routedContextSha256, "routedContextSha256"),
        outputTokenCeiling: submission.outputTokenCeiling,
        reasoningTokenCeiling: submission.reasoningTokenCeiling,
        temperatureMilli: submission.temperatureMilli,
        operationId: normalizeRemoteWorkerInferenceOperationIdentifier(input.operationId, "operationId"),
        dispatchGeneration: normalizeRemoteWorkerInferenceOperationIdentifier(
          input.dispatchGeneration,
          "dispatchGeneration",
        ),
        state,
        governanceDecision: governance.decision,
        effectiveRouteSha256: governance.effectiveRouteSha256,
        policyRevision: governance.policyRevision,
        policySha256: governance.policySha256,
        approvalReceiptSha256: governance.approvalReceiptSha256 ?? null,
        governanceOutputTokenCeiling: governance.outputTokenCeiling,
        governanceReasoningTokenCeiling: governance.reasoningTokenCeiling,
        governanceExpiresAt: governance.expiresAt,
        effectiveRouteJson: effectiveRoute ? canonicalJsonString(effectiveRoute) : null,
        budgetAuthorityState,
        budgetOperationId: input.budgetOperation?.operationId ?? null,
        budgetOperationJson: budgetOperationMaterial ? canonicalJsonString(budgetOperationMaterial) : null,
        budgetOperationSha256: budgetOperationSha256 ?? null,
        admittedAt: assertTimestamp(input.admittedAt, "admittedAt"),
      });
      return { disposition: "created", request: this.getRequestRow(keyOf(submission)) };
    });
  }

  /** Persist the exact idempotent budget-owner receipt before dispatch is claimable. */
  public recordBudgetReservation(
    key: RemoteWorkerInferenceRequestKey,
    reservationInput: RemoteWorkerInferenceBudgetReservation,
    now: string,
  ): RemoteWorkerInferenceRequestRecord {
    const reservation = normalizeRemoteWorkerInferenceBudgetReservation(reservationInput);
    const recordedAt = assertTimestamp(now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      if (current.budgetAuthorityState === "reserved") {
        if (current.budgetReservationSha256 !== remoteWorkerInferenceCanonicalSha256(reservation)) {
          throw new RemoteWorkerInferenceConflictError("Remote worker inference budget reservation replay drifted.");
        }
        return current;
      }
      if (
        current.state !== "admitted" ||
        current.budgetAuthorityState !== "reservation_pending" ||
        current.budgetOperationId !== reservation.operationId ||
        current.budgetOperationSha256 !== reservation.operationSha256 ||
        current.requestSha256 !== reservation.requestSha256 ||
        current.effectiveRouteSha256 !== reservation.effectiveRouteSha256
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference budget reservation does not bind the pending operation.",
        );
      }
      if (!current.budgetOperationJson) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference budget operation evidence is missing.");
      }
      const operation = JSON.parse(current.budgetOperationJson) as RemoteWorkerInferenceBudgetOperationInput;
      if (
        reservation.reservedOutputTokens !== operation.outputTokenCeiling ||
        reservation.reservedReasoningTokens !== operation.reasoningTokenCeiling
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference reservation ceilings do not match the exact budget operation.",
        );
      }
      const reservationJson = canonicalJsonString(reservation);
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET budget_authority_state = 'reserved', budget_reservation_id = @reservationId,
                 budget_reservation_json = @reservationJson, budget_reservation_sha256 = @reservationSha256,
                 budget_reservation_expires_at = @reservationExpiresAt, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'admitted' AND budget_authority_state = 'reservation_pending'`,
        )
        .run({
          reservationId: reservation.reservationId,
          reservationJson,
          reservationSha256: remoteWorkerInferenceCanonicalSha256(reservation),
          reservationExpiresAt: reservation.expiresAt,
          now: recordedAt,
          ...key,
        });
      return this.getRequestRow(key);
    });
  }

  /** Boundary 4: acquire the one-winner dispatch claim only from reserved authority. */
  public claimDispatch(input: RemoteWorkerInferenceDispatchClaimInput): RemoteWorkerInferenceRequestRecord | undefined {
    const databaseNow =
      this.db.dialect === "postgres"
        ? `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(keyOf(input));
      if (
        !current.effectiveRouteJson ||
        current.effectiveRouteSha256 !== assertDigest(input.effectiveRouteSha256, "effectiveRouteSha256")
      ) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference dispatch route evidence is incomplete.");
      }
      const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(
        JSON.parse(current.effectiveRouteJson) as RemoteWorkerInferenceEffectiveRouteReceipt,
      );
      if (
        route.providerId !== input.effectiveProviderId ||
        route.modelId !== input.effectiveModelId ||
        remoteWorkerInferenceEffectiveRouteSha256(route) !== current.effectiveRouteSha256
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference dispatch route drifted from stored evidence.",
        );
      }
      const leaseExpiresAt = assertTimestamp(input.dispatchLeaseExpiresAt, "dispatchLeaseExpiresAt");
      const governanceExpiresAt = current.continuationGovernanceExpiresAt ?? current.governanceExpiresAt;
      if (
        !current.budgetReservationExpiresAt ||
        Date.parse(leaseExpiresAt) > Date.parse(governanceExpiresAt) ||
        Date.parse(leaseExpiresAt) > Date.parse(current.budgetReservationExpiresAt)
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference dispatch lease exceeds admitted authority.",
        );
      }
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'dispatch_claimed',
                 dispatch_claim_owner = @owner,
                 dispatch_claimed_at = @now,
                 dispatch_lease_expires_at = @leaseExpiresAt,
                 effective_provider_id = @providerId,
                 effective_model_id = @modelId,
                 accounting_disposition = 'delegated',
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'admitted'
             AND budget_authority_state = 'reserved'
             AND COALESCE(continuation_governance_expires_at, governance_expires_at) > ${databaseNow}
             AND budget_reservation_expires_at > ${databaseNow}
             AND dispatch_claim_owner IS NULL`,
        )
        .run({
          owner: normalizeRemoteWorkerInferenceOperationIdentifier(input.dispatchClaimOwner, "dispatchClaimOwner"),
          now: assertTimestamp(input.now, "now"),
          leaseExpiresAt,
          providerId: assertBounded(input.effectiveProviderId, "effectiveProviderId"),
          modelId: assertBounded(input.effectiveModelId, "effectiveModelId"),
          registryWorkspaceId: input.registryWorkspaceId,
          assignmentId: input.assignmentId,
          assignmentGeneration: input.assignmentGeneration,
          inferenceRequestId: input.inferenceRequestId,
          attempt: input.attempt,
        }).changes;
      if (changed !== 1) return undefined;
      return this.getRequestRow(keyOf(input));
    });
  }

  /**
   * Continue a waiting request only with an approval-owner receipt, a fresh
   * allowed governance receipt, the exact route receipt, and budget identity.
   */
  public recordApprovalContinuation(
    input: RemoteWorkerInferenceApprovalContinuationInput,
  ): RemoteWorkerInferenceRequestRecord | undefined {
    const resolution = normalizeRemoteWorkerInferenceApprovalResolutionReceipt(input.approvalResolution);
    const governance = normalizeRemoteWorkerInferenceGovernanceReceipt(input.governance);
    const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(input.effectiveRoute);
    const operationMaterial = remoteWorkerInferenceBudgetOperationMaterial(input.budgetOperation);
    const operationSha256 = remoteWorkerInferenceBudgetOperationSha256(input.budgetOperation);
    const continuedAt = assertTimestamp(input.now, "now");
    if (resolution.decision !== "approved" || governance.decision !== "allowed") {
      throw new TypeError("Remote worker inference approval continuation requires approved and allowed receipts.");
    }
    if (remoteWorkerInferenceEffectiveRouteSha256(route) !== governance.effectiveRouteSha256) {
      throw new RemoteWorkerInferenceConflictError("Remote worker inference continuation route digest drifted.");
    }
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(keyOf(input));
      if (
        Date.parse(resolution.resolvedAt) < Date.parse(current.admittedAt) ||
        Date.parse(resolution.resolvedAt) > Date.parse(continuedAt) ||
        Date.parse(governance.expiresAt) <= Date.parse(continuedAt) ||
        current.approvalReceiptSha256 !== resolution.pendingApprovalReceiptSha256 ||
        current.requestSha256 !== input.budgetOperation.requestSha256 ||
        input.budgetOperation.effectiveRouteSha256 !== governance.effectiveRouteSha256 ||
        current.operationId !== input.budgetOperation.operationId ||
        current.dispatchGeneration !== input.budgetOperation.dispatchGeneration ||
        current.effectiveRouteSha256 !== governance.effectiveRouteSha256 ||
        current.registryWorkspaceId !== input.budgetOperation.registryWorkspaceId ||
        current.executionWorkspaceId !== input.budgetOperation.executionWorkspaceId ||
        current.assignmentId !== input.budgetOperation.assignmentId ||
        current.assignmentGeneration !== input.budgetOperation.assignmentGeneration ||
        current.workerId !== input.budgetOperation.workerId ||
        current.workerGeneration !== input.budgetOperation.workerGeneration ||
        current.admittedLeaseRevision !== input.budgetOperation.admittedLeaseRevision ||
        current.sessionId !== input.budgetOperation.sessionId ||
        current.turnId !== input.budgetOperation.turnId ||
        current.durableRunId !== input.budgetOperation.durableRunId ||
        current.taskId !== input.budgetOperation.taskId ||
        current.capabilityProfileSha256 !== input.budgetOperation.capabilityProfileSha256 ||
        current.routedContextSha256 !== input.budgetOperation.routedContextSha256 ||
        input.budgetOperation.outputTokenCeiling !==
          Math.min(current.outputTokenCeiling, governance.outputTokenCeiling) ||
        input.budgetOperation.reasoningTokenCeiling !==
          Math.min(current.reasoningTokenCeiling, governance.reasoningTokenCeiling)
      ) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference approval continuation evidence drifted.");
      }
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'admitted', budget_authority_state = 'reservation_pending',
                 approval_resolution_json = @approvalResolutionJson,
                 approval_resolution_sha256 = @approvalResolutionSha256,
                 approval_resolved_at = @approvalResolvedAt,
                 continuation_governance_json = @continuationGovernanceJson,
                 continuation_governance_sha256 = @continuationGovernanceSha256,
                 continuation_governance_expires_at = @continuationGovernanceExpiresAt,
                 effective_route_json = @effectiveRouteJson,
                 budget_operation_id = @budgetOperationId,
                 budget_operation_json = @budgetOperationJson,
                 budget_operation_sha256 = @budgetOperationSha256,
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'waiting_approval' AND budget_authority_state = 'not_required'`,
        )
        .run({
          approvalResolutionJson: canonicalJsonString(resolution),
          approvalResolutionSha256: remoteWorkerInferenceCanonicalSha256(resolution),
          approvalResolvedAt: resolution.resolvedAt,
          continuationGovernanceJson: canonicalJsonString(governance),
          continuationGovernanceSha256: remoteWorkerInferenceCanonicalSha256(governance),
          continuationGovernanceExpiresAt: governance.expiresAt,
          effectiveRouteJson: canonicalJsonString(route),
          budgetOperationId: input.budgetOperation.operationId,
          budgetOperationJson: canonicalJsonString(operationMaterial),
          budgetOperationSha256: operationSha256,
          now: continuedAt,
          ...keyOf(input),
        }).changes;
      if (changed !== 1) return undefined;
      return this.getRequestRow(keyOf(input));
    });
  }

  /**
   * Persist the non-dispatchable exact release intent before the external
   * budget owner is invoked. A concurrent dispatch claim and this transition
   * race on the same admitted row; only one can commit.
   */
  public recordBudgetReleaseIntent(
    key: RemoteWorkerInferenceRequestKey,
    input: { blockReason: string; reason: RemoteWorkerInferenceReleaseReason; now: string },
  ): RemoteWorkerInferenceRequestRecord {
    const reason = normalizeRemoteWorkerInferenceReleaseReason(input.reason);
    const blockReason = normalizeRemoteWorkerInferenceOperationIdentifier(input.blockReason, "blockReason");
    const requestedAt = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      if (current.state === "blocked" && ["reserved", "released"].includes(current.budgetAuthorityState)) {
        if (
          current.budgetReleaseReason !== reason ||
          current.blockReason !== blockReason ||
          !current.budgetReleaseRequestedAt
        ) {
          throw new RemoteWorkerInferenceConflictError("Remote worker inference budget release intent drifted.");
        }
        return current;
      }
      if (
        current.state !== "admitted" ||
        current.budgetAuthorityState !== "reserved" ||
        current.dispatchClaimOwner !== undefined
      ) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference budget release intent lost the pre-dispatch claim race.",
        );
      }
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'blocked', block_reason = @blockReason,
                 budget_release_reason = @reason, budget_release_requested_at = @requestedAt,
                 updated_at = @requestedAt
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'admitted' AND budget_authority_state = 'reserved'
             AND dispatch_claim_owner IS NULL`,
        )
        .run({ blockReason, reason, requestedAt, ...key }).changes;
      if (changed !== 1) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference budget release intent lost the pre-dispatch claim race.",
        );
      }
      return this.getRequestRow(key);
    });
  }

  /** Commit the exact reserved -> released transition after idempotent release. */
  public markBudgetReleased(
    key: RemoteWorkerInferenceRequestKey,
    reasonInput: RemoteWorkerInferenceReleaseReason,
    now: string,
  ): RemoteWorkerInferenceRequestRecord {
    const reason = normalizeRemoteWorkerInferenceReleaseReason(reasonInput);
    const releasedAt = assertTimestamp(now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      if (current.budgetAuthorityState === "released") {
        if (current.state !== "blocked" || current.budgetReleaseReason !== reason) {
          throw new RemoteWorkerInferenceConflictError("Remote worker inference budget release replay drifted.");
        }
        return current;
      }
      if (
        current.state !== "blocked" ||
        current.budgetAuthorityState !== "reserved" ||
        current.budgetReleaseReason !== reason ||
        !current.budgetReleaseRequestedAt
      ) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference budget release intent is incomplete.");
      }
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET budget_authority_state = 'released', budget_released_at = @releasedAt,
                 updated_at = @releasedAt
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'blocked' AND budget_authority_state = 'reserved'
             AND budget_release_reason = @reason`,
        )
        .run({ reason, releasedAt, ...key }).changes;
      if (changed !== 1) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference budget release commit lost authority.");
      }
      return this.getRequestRow(key);
    });
  }

  /** Persist a rejected approval or a denial before any reservation exists. */
  public blockBeforeDispatch(
    key: RemoteWorkerInferenceRequestKey,
    input: {
      reason: string;
      approvalResolution?: RemoteWorkerInferenceApprovalResolutionReceipt;
      now: string;
    },
  ): RemoteWorkerInferenceRequestRecord {
    const approval = input.approvalResolution
      ? normalizeRemoteWorkerInferenceApprovalResolutionReceipt(input.approvalResolution)
      : undefined;
    const blockReason = normalizeRemoteWorkerInferenceOperationIdentifier(input.reason, "blockReason");
    const blockedAt = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      if (!(["admitted", "waiting_approval", "blocked"] as string[]).includes(current.state)) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference cannot be blocked after dispatch.");
      }
      if (current.state === "blocked") {
        if (current.blockReason !== blockReason || current.budgetAuthorityState !== "not_required") {
          throw new RemoteWorkerInferenceConflictError("Remote worker inference block replay drifted.");
        }
        return current;
      }
      if (!(["not_required", "reservation_pending"] as string[]).includes(current.budgetAuthorityState)) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference reserved budget requires a durable release intent before blocking.",
        );
      }
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'blocked', budget_authority_state = 'not_required',
                 block_reason = @blockReason,
                 approval_resolution_json = COALESCE(@approvalResolutionJson, approval_resolution_json),
                 approval_resolution_sha256 = COALESCE(@approvalResolutionSha256, approval_resolution_sha256),
                 approval_resolved_at = COALESCE(@approvalResolvedAt, approval_resolved_at),
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({
          blockReason,
          approvalResolutionJson: approval ? canonicalJsonString(approval) : null,
          approvalResolutionSha256: approval ? remoteWorkerInferenceCanonicalSha256(approval) : null,
          approvalResolvedAt: approval?.resolvedAt ?? null,
          now: blockedAt,
          ...key,
        });
      return this.getRequestRow(key);
    });
  }

  /** Boundary 6: append one hash-chained output frame and advance the counters/state. */
  public appendOutputFrame(input: RemoteWorkerInferenceFrameAppendInput): RemoteWorkerInferenceFrameAppendOutcome {
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(keyOf(input));
      assertClaimant(current, input.dispatchClaimOwner);
      if (current.state !== "dispatch_claimed" && current.state !== "streaming") {
        throw new RemoteWorkerInferenceConflictError(
          `Remote worker inference request is not dispatchable in state ${current.state}.`,
        );
      }
      const payload = normalizeRemoteWorkerInferenceFramePayload({
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "output_text",
        text: input.text,
      });
      const frameCharCount = input.text.length;
      const nextCharCount = current.outputCharCount + frameCharCount;
      if (nextCharCount > REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference output exceeds the bounded budget.");
      }
      const frame = this.insertFrame(current, "output_text", payload, frameCharCount, undefined, input.now);
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'streaming', output_frame_count = @frameCount,
                 output_char_count = @charCount, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({
          frameCount: frame.frameSequence,
          charCount: nextCharCount,
          now: assertTimestamp(input.now, "now"),
          ...keyOf(input),
        });
      return { frame, request: this.getRequestRow(keyOf(input)) };
    });
  }

  /**
   * Boundary 8: atomically append the terminal frame and finalize the request
   * from HX-306 receipts. Terminal state and terminal frame commit together and
   * are immutable thereafter.
   */
  public finalizeTerminal(input: RemoteWorkerInferenceFinalizeInput): RemoteWorkerInferenceRequestRecord {
    if (input.terminalState === "dispatch_unknown") {
      throw new TypeError("Use markDispatchUnknown for an unrecoverable dispatch, not finalizeTerminal.");
    }
    const usageEventIds = normalizeRemoteWorkerInferenceUsageEventIds(input.usageEventIds);
    const usageIntentEventId = usageEventIds[0]!;
    const usageTerminalEventId = usageEventIds[usageEventIds.length - 1]!;
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(keyOf(input));
      assertClaimant(current, input.dispatchClaimOwner);
      if (current.state !== "dispatch_claimed" && current.state !== "streaming") {
        throw new RemoteWorkerInferenceConflictError(
          `Remote worker inference request cannot terminate from state ${current.state}.`,
        );
      }
      const payload = normalizeRemoteWorkerInferenceFramePayload({
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "terminal",
        terminalState: input.terminalState,
        usageEventId: usageTerminalEventId,
      });
      const frame = this.insertFrame(current, "terminal", payload, 0, usageTerminalEventId, input.now);
      const usageEventIdsJson = canonicalJsonString(usageEventIds);
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = @state, output_frame_count = @frameCount,
                 terminal_frame_sequence = @terminalSequence, terminal_sha256 = @terminalSha256,
                 usage_intent_event_id = @usageIntentEventId,
                 usage_terminal_event_id = @usageTerminalEventId,
                 usage_event_ids_json = @usageEventIdsJson,
                 usage_event_ids_sha256 = @usageEventIdsSha256,
                 budget_authority_state = 'settlement_pending', accounting_disposition = 'delegated',
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({
          state: input.terminalState,
          frameCount: frame.frameSequence,
          terminalSequence: frame.frameSequence,
          terminalSha256: frame.frameSha256,
          usageIntentEventId,
          usageTerminalEventId,
          usageEventIdsJson,
          usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(usageEventIds),
          now: assertTimestamp(input.now, "now"),
          ...keyOf(input),
        });
      return this.getRequestRow(keyOf(input));
    });
  }

  /**
   * Recovery/failure: provider acceptance without an exact recoverable terminal.
   * No terminal frame is written; the request is unknown/manual and never
   * triggers speculative redispatch.
   */
  public markDispatchUnknown(
    key: RemoteWorkerInferenceRequestKey,
    input: { dispatchClaimOwner: string; usageEventIds?: readonly string[]; now: string },
  ): RemoteWorkerInferenceRequestRecord {
    const usageEventIds = input.usageEventIds?.length
      ? normalizeRemoteWorkerInferenceUsageEventIds(input.usageEventIds)
      : undefined;
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      assertClaimant(current, input.dispatchClaimOwner);
      if (current.state !== "dispatch_claimed" && current.state !== "streaming") {
        throw new RemoteWorkerInferenceConflictError(
          `Remote worker inference request cannot become dispatch_unknown from state ${current.state}.`,
        );
      }
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'dispatch_unknown', accounting_disposition = 'unknown',
                 budget_authority_state = 'reconciliation_required',
                 usage_intent_event_id = COALESCE(@usageIntentEventId, usage_intent_event_id),
                 usage_terminal_event_id = COALESCE(@usageTerminalEventId, usage_terminal_event_id),
                 usage_event_ids_json = COALESCE(@usageEventIdsJson, usage_event_ids_json),
                 usage_event_ids_sha256 = COALESCE(@usageEventIdsSha256, usage_event_ids_sha256),
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({
          usageIntentEventId: usageEventIds?.[0] ?? null,
          usageTerminalEventId: usageEventIds?.[usageEventIds.length - 1] ?? null,
          usageEventIdsJson: usageEventIds ? canonicalJsonString(usageEventIds) : null,
          usageEventIdsSha256: usageEventIds ? remoteWorkerInferenceUsageEventIdsSha256(usageEventIds) : null,
          now: assertTimestamp(input.now, "now"),
          ...key,
        });
      return this.getRequestRow(key);
    });
  }

  /**
   * Restart recovery for an expired dispatch claim. The database clock owns
   * expiry; no provider redispatch or speculative budget release occurs.
   */
  public recoverExpiredDispatchUnknown(
    key: RemoteWorkerInferenceRequestKey,
    now: string,
  ): RemoteWorkerInferenceRequestRecord | undefined {
    const databaseNow =
      this.db.dialect === "postgres"
        ? `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    return this.db.transaction("immediate", () => {
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'dispatch_unknown', accounting_disposition = 'unknown',
                 budget_authority_state = 'reconciliation_required', updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state IN ('dispatch_claimed', 'streaming')
             AND dispatch_lease_expires_at <= ${databaseNow}`,
        )
        .run({ now: assertTimestamp(now, "now"), ...key }).changes;
      return changed === 1 ? this.getRequestRow(key) : undefined;
    });
  }

  /** Complete an idempotent external settlement after the terminal commit. */
  public markBudgetSettled(key: RemoteWorkerInferenceRequestKey, now: string): RemoteWorkerInferenceRequestRecord {
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      if (current.budgetAuthorityState === "settled") return current;
      if (current.budgetAuthorityState !== "settlement_pending") {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference budget is not settlement-pending.");
      }
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET budget_authority_state = 'settled', budget_settled_at = @now,
                 accounting_disposition = 'settled', updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt AND budget_authority_state = 'settlement_pending'`,
        )
        .run({ now: assertTimestamp(now, "now"), ...key });
      return this.getRequestRow(key);
    });
  }

  /** Boundary 9: advance the worker acknowledgement watermark (append-only frames). */
  public acknowledge(
    key: RemoteWorkerInferenceRequestKey,
    throughSequence: number,
    now: string,
  ): RemoteWorkerInferenceRequestRecord {
    return this.db.transaction("immediate", () => {
      const current = this.getRequestRow(key);
      const target = assertNonNegative(throughSequence, "throughSequence");
      if (target > current.outputFrameCount) {
        throw new RemoteWorkerInferenceConflictError(
          "Remote worker inference acknowledgement cannot exceed the delivered frame count.",
        );
      }
      if (target < current.workerAcknowledgedThrough) {
        throw new RemoteWorkerInferenceConflictError("Remote worker inference acknowledgement cannot regress.");
      }
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET worker_acknowledged_through = @target, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({ target, now: assertTimestamp(now, "now"), ...key });
      return this.getRequestRow(key);
    });
  }

  public getRequest(key: RemoteWorkerInferenceRequestKey): RemoteWorkerInferenceRequestRecord | undefined {
    const row = this.selectStmt().get({ ...key }) as RequestRow | undefined;
    return row ? mapRequest(row) : undefined;
  }

  public getRequestByIdempotency(
    registryWorkspaceId: string,
    idempotencyKey: string,
  ): RemoteWorkerInferenceRequestRecord | undefined {
    const row = this.findByIdempotency(registryWorkspaceId, idempotencyKey);
    return row ? mapRequest(row) : undefined;
  }

  /** Durable-outbox replay after restart/reconnect: frames strictly after the watermark. */
  public listFramesAfter(
    key: RemoteWorkerInferenceRequestKey,
    afterSequence: number,
  ): RemoteWorkerInferenceFrameRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_worker_inference_outbox
          WHERE registry_workspace_id = @registryWorkspaceId
            AND assignment_id = @assignmentId
            AND assignment_generation = @assignmentGeneration
            AND inference_request_id = @inferenceRequestId
            AND attempt = @attempt
            AND frame_sequence > @afterSequence
          ORDER BY frame_sequence ASC`,
      )
      .all({ ...key, afterSequence: assertNonNegative(afterSequence, "afterSequence") }) as FrameRow[];
    return rows.map(mapFrame);
  }

  // --- internals ------------------------------------------------------------

  private insertFrame(
    request: RemoteWorkerInferenceRequestRecord,
    frameKind: RemoteWorkerInferenceFrameKind,
    payload: object,
    frameCharCount: number,
    usageEventId: string | undefined,
    now: string,
  ): RemoteWorkerInferenceFrameRecord {
    const last = this.db
      .prepare(
        `SELECT frame_sequence, frame_sha256 FROM remote_worker_inference_outbox
          WHERE registry_workspace_id = @registryWorkspaceId
            AND assignment_id = @assignmentId
            AND assignment_generation = @assignmentGeneration
            AND inference_request_id = @inferenceRequestId
            AND attempt = @attempt
          ORDER BY frame_sequence DESC LIMIT 1`,
      )
      .get(keyOf(request)) as { frame_sequence: number | bigint; frame_sha256: string } | undefined;
    const frameSequence = last ? asInt(last.frame_sequence) + 1 : 1;
    const previousFrameSha256 = last ? last.frame_sha256 : REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256;
    const payloadSha256 = remoteWorkerInferenceFramePayloadSha256(payload as never);
    const frameSha256 = remoteWorkerInferenceFrameSha256({
      registryWorkspaceId: request.registryWorkspaceId,
      assignmentId: request.assignmentId,
      assignmentGeneration: request.assignmentGeneration,
      inferenceRequestId: request.inferenceRequestId,
      attempt: request.attempt,
      frameSequence,
      frameKind,
      payloadSha256,
      previousFrameSha256,
      effectiveRouteSha256: request.effectiveRouteSha256,
    });
    this.db
      .prepare(
        `INSERT INTO remote_worker_inference_outbox (
           registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt,
           frame_sequence, frame_kind, payload_json, payload_sha256, previous_frame_sha256, frame_sha256,
           effective_route_sha256, usage_event_id, frame_char_count, created_at
         ) VALUES (
           @registryWorkspaceId, @assignmentId, @assignmentGeneration, @inferenceRequestId, @attempt,
           @frameSequence, @frameKind, @payloadJson, @payloadSha256, @previousFrameSha256, @frameSha256,
           @effectiveRouteSha256, @usageEventId, @frameCharCount, @createdAt
         )`,
      )
      .run({
        registryWorkspaceId: request.registryWorkspaceId,
        assignmentId: request.assignmentId,
        assignmentGeneration: request.assignmentGeneration,
        inferenceRequestId: request.inferenceRequestId,
        attempt: request.attempt,
        frameSequence,
        frameKind,
        payloadJson: canonicalJsonString(payload),
        payloadSha256,
        previousFrameSha256,
        frameSha256,
        effectiveRouteSha256: request.effectiveRouteSha256,
        usageEventId: usageEventId ?? null,
        frameCharCount,
        createdAt: assertTimestamp(now, "now"),
      });
    return {
      registryWorkspaceId: request.registryWorkspaceId,
      assignmentId: request.assignmentId,
      assignmentGeneration: request.assignmentGeneration,
      inferenceRequestId: request.inferenceRequestId,
      attempt: request.attempt,
      frameSequence,
      frameKind,
      payloadJson: canonicalJsonString(payload),
      payloadSha256,
      previousFrameSha256,
      frameSha256,
      effectiveRouteSha256: request.effectiveRouteSha256,
      ...(usageEventId === undefined ? {} : { usageEventId }),
      frameCharCount,
      createdAt: now,
    };
  }

  private getRequestRow(key: RemoteWorkerInferenceRequestKey): RemoteWorkerInferenceRequestRecord {
    const record = this.getRequest(key);
    if (!record) {
      throw new RemoteWorkerInferenceConflictError("Remote worker inference request not found.");
    }
    return record;
  }

  private findByIdempotency(registryWorkspaceId: string, idempotencyKey: string): RequestRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_inference_requests
          WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as RequestRow | undefined;
  }

  private selectStmt() {
    return this.db.prepare(
      `SELECT * FROM remote_worker_inference_requests
        WHERE registry_workspace_id = @registryWorkspaceId
          AND assignment_id = @assignmentId
          AND assignment_generation = @assignmentGeneration
          AND inference_request_id = @inferenceRequestId
          AND attempt = @attempt`,
    );
  }

  private insertStmt() {
    return this.db.prepare(
      `INSERT INTO remote_worker_inference_requests (
         registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt,
         worker_id, worker_generation, execution_workspace_id, session_id, turn_id, durable_run_id, task_id,
         admitted_lease_revision, idempotency_key,
         request_body_json, request_sha256, input_sha256, context_sha256, model_intent_sha256,
         capability_profile_sha256, routed_context_sha256, output_token_ceiling, reasoning_token_ceiling,
         temperature_milli, operation_id, dispatch_generation, state, governance_decision,
         effective_route_sha256, policy_revision, policy_sha256, approval_receipt_sha256,
         governance_output_token_ceiling, governance_reasoning_token_ceiling, governance_expires_at,
         legacy_budget_reservation_marker, effective_route_json, budget_authority_state,
         budget_operation_id, budget_operation_json, budget_operation_sha256, admitted_at, updated_at
       ) VALUES (
         @registryWorkspaceId, @assignmentId, @assignmentGeneration, @inferenceRequestId, @attempt,
         @workerId, @workerGeneration, @executionWorkspaceId, @sessionId, @turnId, @durableRunId, @taskId,
         @admittedLeaseRevision, @idempotencyKey,
         @requestBodyJson, @requestSha256, @inputSha256, @contextSha256, @modelIntentSha256,
         @capabilityProfileSha256, @routedContextSha256, @outputTokenCeiling, @reasoningTokenCeiling,
         @temperatureMilli, @operationId, @dispatchGeneration, @state, @governanceDecision,
         @effectiveRouteSha256, @policyRevision, @policySha256, @approvalReceiptSha256,
         @governanceOutputTokenCeiling, @governanceReasoningTokenCeiling, @governanceExpiresAt,
         'v2:no-legacy-budget-reservation', @effectiveRouteJson, @budgetAuthorityState,
         @budgetOperationId, @budgetOperationJson, @budgetOperationSha256, @admittedAt, @admittedAt
       )`,
    );
  }
}

interface RequestRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  inference_request_id: string;
  attempt: number | bigint | string;
  worker_id: string;
  worker_generation: number | bigint | string;
  execution_workspace_id: string | null;
  session_id: string;
  turn_id: string;
  durable_run_id: string | null;
  task_id: string | null;
  admitted_lease_revision: number | bigint | string | null;
  idempotency_key: string;
  request_body_json: string;
  request_sha256: string;
  input_sha256: string;
  context_sha256: string;
  model_intent_sha256: string;
  capability_profile_sha256: string;
  routed_context_sha256: string;
  output_token_ceiling: number | bigint | string;
  reasoning_token_ceiling: number | bigint | string;
  temperature_milli: number | bigint | string;
  operation_id: string;
  dispatch_generation: string;
  state: string;
  governance_decision: string;
  effective_route_sha256: string;
  policy_revision: number | bigint | string;
  policy_sha256: string;
  approval_receipt_sha256: string | null;
  governance_output_token_ceiling: number | bigint | string;
  governance_reasoning_token_ceiling: number | bigint | string;
  governance_expires_at: string;
  legacy_budget_reservation_marker: string;
  effective_route_json: string | null;
  approval_resolution_json: string | null;
  approval_resolution_sha256: string | null;
  approval_resolved_at: string | null;
  continuation_governance_json: string | null;
  continuation_governance_sha256: string | null;
  continuation_governance_expires_at: string | null;
  budget_authority_state: string;
  budget_operation_id: string | null;
  budget_operation_json: string | null;
  budget_operation_sha256: string | null;
  budget_reservation_id: string | null;
  budget_reservation_json: string | null;
  budget_reservation_sha256: string | null;
  budget_reservation_expires_at: string | null;
  effective_provider_id: string | null;
  effective_model_id: string | null;
  dispatch_claim_owner: string | null;
  dispatch_claimed_at: string | null;
  dispatch_lease_expires_at: string | null;
  usage_intent_event_id: string | null;
  usage_terminal_event_id: string | null;
  usage_event_ids_json: string | null;
  usage_event_ids_sha256: string | null;
  output_frame_count: number | bigint | string;
  output_char_count: number | bigint | string;
  worker_acknowledged_through: number | bigint | string;
  terminal_frame_sequence: number | bigint | string | null;
  terminal_sha256: string | null;
  accounting_disposition: string | null;
  budget_settled_at: string | null;
  budget_released_at: string | null;
  budget_release_reason: string | null;
  budget_release_requested_at: string | null;
  block_reason: string | null;
  admitted_at: string;
  updated_at: string;
}

interface FrameRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  inference_request_id: string;
  attempt: number | bigint | string;
  frame_sequence: number | bigint | string;
  frame_kind: string;
  payload_json: string;
  payload_sha256: string;
  previous_frame_sha256: string;
  frame_sha256: string;
  effective_route_sha256: string;
  usage_event_id: string | null;
  frame_char_count: number | bigint | string;
  created_at: string;
}

function mapRequest(row: RequestRow): RemoteWorkerInferenceRequestRecord {
  return {
    registryWorkspaceId: row.registry_workspace_id,
    assignmentId: row.assignment_id,
    assignmentGeneration: asInt(row.assignment_generation),
    inferenceRequestId: row.inference_request_id,
    attempt: asInt(row.attempt),
    workerId: row.worker_id,
    workerGeneration: asInt(row.worker_generation),
    ...(row.execution_workspace_id === null ? {} : { executionWorkspaceId: row.execution_workspace_id }),
    sessionId: row.session_id,
    turnId: row.turn_id,
    ...(row.durable_run_id === null ? {} : { durableRunId: row.durable_run_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.admitted_lease_revision === null ? {} : { admittedLeaseRevision: asInt(row.admitted_lease_revision) }),
    idempotencyKey: row.idempotency_key,
    requestBodyJson: row.request_body_json,
    requestSha256: row.request_sha256,
    inputSha256: row.input_sha256,
    contextSha256: row.context_sha256,
    modelIntentSha256: row.model_intent_sha256,
    capabilityProfileSha256: row.capability_profile_sha256,
    routedContextSha256: row.routed_context_sha256,
    outputTokenCeiling: asInt(row.output_token_ceiling),
    reasoningTokenCeiling: asInt(row.reasoning_token_ceiling),
    temperatureMilli: asInt(row.temperature_milli),
    operationId: row.operation_id,
    dispatchGeneration: row.dispatch_generation,
    state: row.state as RemoteWorkerInferenceState,
    governanceDecision: row.governance_decision as RemoteWorkerInferenceGovernanceReceipt["decision"],
    effectiveRouteSha256: row.effective_route_sha256,
    policyRevision: asInt(row.policy_revision),
    policySha256: row.policy_sha256,
    ...(row.approval_receipt_sha256 === null ? {} : { approvalReceiptSha256: row.approval_receipt_sha256 }),
    governanceOutputTokenCeiling: asInt(row.governance_output_token_ceiling),
    governanceReasoningTokenCeiling: asInt(row.governance_reasoning_token_ceiling),
    governanceExpiresAt: row.governance_expires_at,
    ...(row.effective_route_json === null ? {} : { effectiveRouteJson: row.effective_route_json }),
    ...(row.approval_resolution_json === null ? {} : { approvalResolutionJson: row.approval_resolution_json }),
    ...(row.approval_resolution_sha256 === null ? {} : { approvalResolutionSha256: row.approval_resolution_sha256 }),
    ...(row.approval_resolved_at === null ? {} : { approvalResolvedAt: row.approval_resolved_at }),
    ...(row.continuation_governance_json === null
      ? {}
      : { continuationGovernanceJson: row.continuation_governance_json }),
    ...(row.continuation_governance_sha256 === null
      ? {}
      : { continuationGovernanceSha256: row.continuation_governance_sha256 }),
    ...(row.continuation_governance_expires_at === null
      ? {}
      : { continuationGovernanceExpiresAt: row.continuation_governance_expires_at }),
    budgetAuthorityState: row.budget_authority_state as RemoteWorkerInferenceBudgetAuthorityState,
    ...(row.budget_operation_id === null ? {} : { budgetOperationId: row.budget_operation_id }),
    ...(row.budget_operation_json === null ? {} : { budgetOperationJson: row.budget_operation_json }),
    ...(row.budget_operation_sha256 === null ? {} : { budgetOperationSha256: row.budget_operation_sha256 }),
    ...(row.budget_reservation_id === null ? {} : { budgetReservationId: row.budget_reservation_id }),
    ...(row.budget_reservation_json === null ? {} : { budgetReservationJson: row.budget_reservation_json }),
    ...(row.budget_reservation_sha256 === null ? {} : { budgetReservationSha256: row.budget_reservation_sha256 }),
    ...(row.budget_reservation_expires_at === null
      ? {}
      : { budgetReservationExpiresAt: row.budget_reservation_expires_at }),
    ...(row.effective_provider_id === null ? {} : { effectiveProviderId: row.effective_provider_id }),
    ...(row.effective_model_id === null ? {} : { effectiveModelId: row.effective_model_id }),
    ...(row.dispatch_claim_owner === null ? {} : { dispatchClaimOwner: row.dispatch_claim_owner }),
    ...(row.dispatch_claimed_at === null ? {} : { dispatchClaimedAt: row.dispatch_claimed_at }),
    ...(row.dispatch_lease_expires_at === null ? {} : { dispatchLeaseExpiresAt: row.dispatch_lease_expires_at }),
    ...(row.usage_intent_event_id === null ? {} : { usageIntentEventId: row.usage_intent_event_id }),
    ...(row.usage_terminal_event_id === null ? {} : { usageTerminalEventId: row.usage_terminal_event_id }),
    ...(row.usage_event_ids_json === null ? {} : { usageEventIdsJson: row.usage_event_ids_json }),
    ...(row.usage_event_ids_sha256 === null ? {} : { usageEventIdsSha256: row.usage_event_ids_sha256 }),
    outputFrameCount: asInt(row.output_frame_count),
    outputCharCount: asInt(row.output_char_count),
    workerAcknowledgedThrough: asInt(row.worker_acknowledged_through),
    ...(row.terminal_frame_sequence === null ? {} : { terminalFrameSequence: asInt(row.terminal_frame_sequence) }),
    ...(row.terminal_sha256 === null ? {} : { terminalSha256: row.terminal_sha256 }),
    ...(row.accounting_disposition === null
      ? {}
      : { accountingDisposition: row.accounting_disposition as "delegated" | "settled" | "unknown" }),
    ...(row.budget_settled_at === null ? {} : { budgetSettledAt: row.budget_settled_at }),
    ...(row.budget_released_at === null ? {} : { budgetReleasedAt: row.budget_released_at }),
    ...(row.budget_release_reason === null
      ? {}
      : { budgetReleaseReason: row.budget_release_reason as RemoteWorkerInferenceReleaseReason }),
    ...(row.budget_release_requested_at === null ? {} : { budgetReleaseRequestedAt: row.budget_release_requested_at }),
    ...(row.block_reason === null ? {} : { blockReason: row.block_reason }),
    admittedAt: row.admitted_at,
    updatedAt: row.updated_at,
  };
}

function mapFrame(row: FrameRow): RemoteWorkerInferenceFrameRecord {
  return {
    registryWorkspaceId: row.registry_workspace_id,
    assignmentId: row.assignment_id,
    assignmentGeneration: asInt(row.assignment_generation),
    inferenceRequestId: row.inference_request_id,
    attempt: asInt(row.attempt),
    frameSequence: asInt(row.frame_sequence),
    frameKind: row.frame_kind as RemoteWorkerInferenceFrameKind,
    payloadJson: row.payload_json,
    payloadSha256: row.payload_sha256,
    previousFrameSha256: row.previous_frame_sha256,
    frameSha256: row.frame_sha256,
    effectiveRouteSha256: row.effective_route_sha256,
    ...(row.usage_event_id === null ? {} : { usageEventId: row.usage_event_id }),
    frameCharCount: asInt(row.frame_char_count),
    createdAt: row.created_at,
  };
}

function admissionState(decision: RemoteWorkerInferenceGovernanceReceipt["decision"]): RemoteWorkerInferenceState {
  if (decision === "allowed") return "admitted";
  if (decision === "approval_required") return "waiting_approval";
  return "blocked";
}

function keyOf(value: RemoteWorkerInferenceRequestKey): RemoteWorkerInferenceRequestKey {
  return {
    registryWorkspaceId: value.registryWorkspaceId,
    assignmentId: value.assignmentId,
    assignmentGeneration: value.assignmentGeneration,
    inferenceRequestId: value.inferenceRequestId,
    attempt: value.attempt,
  };
}

function assertClaimant(request: RemoteWorkerInferenceRequestRecord, owner: string): void {
  if (request.dispatchClaimOwner !== owner) {
    throw new RemoteWorkerInferenceConflictError("Remote worker inference dispatch claim owner mismatch.");
  }
}

function asInt(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Remote worker inference stored integer is out of safe range.");
  }
  return parsed;
}

function assertBounded(value: string, field: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TypeError(`Remote worker inference ${field} is invalid.`);
  }
  return value;
}

function assertDigest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker inference ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function assertPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Remote worker inference ${field} must be a positive integer.`);
  }
  return value;
}

function assertNonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Remote worker inference ${field} must be a non-negative integer.`);
  }
  return value;
}

function assertTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Remote worker inference ${field} must be a canonical UTC timestamp.`);
  }
  return value;
}
