import {
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS,
  canonicalJsonString,
  normalizeRemoteWorkerInferenceFramePayload,
  normalizeRemoteWorkerInferenceGovernanceReceipt,
  normalizeRemoteWorkerInferenceRequestSubmission,
  remoteWorkerInferenceCanonicalRequestBody,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceRequestSha256,
  type RemoteWorkerInferenceFrameKind,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceRequestSubmission,
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
 * credential, and the append-only outbox frames never carry provider errors,
 * headers, bodies, private reasoning, or secrets.
 *
 * Every mutation runs in an immediate transaction. The database independently
 * enforces immutable bindings, terminal immutability (only the monotonic
 * acknowledgement watermark advances), the append-only hash-chained outbox, and
 * the one-winner dispatch claim.
 */

export interface RemoteWorkerInferenceAdmissionInput {
  readonly submission: RemoteWorkerInferenceRequestSubmission;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly capabilityProfileSha256: string;
  readonly routedContextSha256: string;
  readonly operationId: string;
  readonly dispatchGeneration: string;
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly budgetReservationId: string;
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
  readonly usageIntentEventId: string;
  readonly dispatchLeaseExpiresAt: string;
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
  readonly usageTerminalEventId?: string;
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
  readonly sessionId: string;
  readonly turnId: string;
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
  readonly budgetReservationId: string;
  readonly effectiveProviderId?: string;
  readonly effectiveModelId?: string;
  readonly dispatchClaimOwner?: string;
  readonly dispatchClaimedAt?: string;
  readonly dispatchLeaseExpiresAt?: string;
  readonly usageIntentEventId?: string;
  readonly usageTerminalEventId?: string;
  readonly outputFrameCount: number;
  readonly outputCharCount: number;
  readonly workerAcknowledgedThrough: number;
  readonly terminalFrameSequence?: number;
  readonly terminalSha256?: string;
  readonly accountingDisposition?: "delegated" | "settled" | "unknown";
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

  /**
   * Boundary 3: insert or exactly replay the request. A reused idempotency key
   * with identical canonical bytes returns the existing request; changed bytes
   * conflict.
   */
  public admitOrReplay(input: RemoteWorkerInferenceAdmissionInput): RemoteWorkerInferenceAdmissionOutcome {
    const submission = normalizeRemoteWorkerInferenceRequestSubmission(input.submission);
    const governance = normalizeRemoteWorkerInferenceGovernanceReceipt(input.governance);
    const requestSha256 = remoteWorkerInferenceRequestSha256(input.submission);
    const bodyJson = canonicalJsonString(remoteWorkerInferenceCanonicalRequestBody(input.submission));
    const state = admissionState(governance.decision);
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
        sessionId: assertBounded(input.sessionId, "sessionId"),
        turnId: assertBounded(input.turnId, "turnId"),
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
        operationId: assertBounded(input.operationId, "operationId"),
        dispatchGeneration: assertBounded(input.dispatchGeneration, "dispatchGeneration"),
        state,
        governanceDecision: governance.decision,
        effectiveRouteSha256: governance.effectiveRouteSha256,
        policyRevision: governance.policyRevision,
        policySha256: governance.policySha256,
        approvalReceiptSha256: governance.approvalReceiptSha256 ?? null,
        governanceOutputTokenCeiling: governance.outputTokenCeiling,
        governanceReasoningTokenCeiling: governance.reasoningTokenCeiling,
        governanceExpiresAt: governance.expiresAt,
        budgetReservationId: assertBounded(input.budgetReservationId, "budgetReservationId"),
        admittedAt: assertTimestamp(input.admittedAt, "admittedAt"),
      });
      return { disposition: "created", request: this.getRequestRow(keyOf(submission)) };
    });
  }

  /** Boundary 4: acquire the one-winner dispatch claim (admitted -> dispatch_claimed). */
  public claimDispatch(input: RemoteWorkerInferenceDispatchClaimInput): RemoteWorkerInferenceRequestRecord | undefined {
    return this.db.transaction("immediate", () => {
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = 'dispatch_claimed',
                 dispatch_claim_owner = @owner,
                 dispatch_claimed_at = @now,
                 dispatch_lease_expires_at = @leaseExpiresAt,
                 effective_provider_id = @providerId,
                 effective_model_id = @modelId,
                 usage_intent_event_id = @usageIntentEventId,
                 accounting_disposition = 'delegated',
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'admitted'
             AND dispatch_claim_owner IS NULL`,
        )
        .run({
          owner: assertBounded(input.dispatchClaimOwner, "dispatchClaimOwner"),
          now: assertTimestamp(input.now, "now"),
          leaseExpiresAt: assertTimestamp(input.dispatchLeaseExpiresAt, "dispatchLeaseExpiresAt"),
          providerId: assertBounded(input.effectiveProviderId, "effectiveProviderId"),
          modelId: assertBounded(input.effectiveModelId, "effectiveModelId"),
          usageIntentEventId: assertBounded(input.usageIntentEventId, "usageIntentEventId"),
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

  /** Resolve a waiting_approval request forward to admitted or block it. */
  public resolveApproval(
    key: RemoteWorkerInferenceRequestKey,
    decision: "admitted" | "blocked",
    now: string,
  ): RemoteWorkerInferenceRequestRecord | undefined {
    return this.db.transaction("immediate", () => {
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = @state, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt
             AND state = 'waiting_approval'`,
        )
        .run({ state: decision, now: assertTimestamp(now, "now"), ...key }).changes;
      if (changed !== 1) return undefined;
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
        ...(input.usageTerminalEventId === undefined ? {} : { usageEventId: input.usageTerminalEventId }),
      });
      const frame = this.insertFrame(current, "terminal", payload, 0, input.usageTerminalEventId, input.now);
      this.db
        .prepare(
          `UPDATE remote_worker_inference_requests
             SET state = @state, output_frame_count = @frameCount,
                 terminal_frame_sequence = @terminalSequence, terminal_sha256 = @terminalSha256,
                 usage_terminal_event_id = @usageTerminalEventId, accounting_disposition = 'settled',
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
          usageTerminalEventId: input.usageTerminalEventId ?? null,
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
    input: { dispatchClaimOwner: string; usageTerminalEventId?: string; now: string },
  ): RemoteWorkerInferenceRequestRecord {
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
                 usage_terminal_event_id = COALESCE(@usageTerminalEventId, usage_terminal_event_id),
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId
             AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND inference_request_id = @inferenceRequestId
             AND attempt = @attempt`,
        )
        .run({
          usageTerminalEventId: input.usageTerminalEventId ?? null,
          now: assertTimestamp(input.now, "now"),
          ...key,
        });
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
         worker_id, worker_generation, session_id, turn_id, idempotency_key,
         request_body_json, request_sha256, input_sha256, context_sha256, model_intent_sha256,
         capability_profile_sha256, routed_context_sha256, output_token_ceiling, reasoning_token_ceiling,
         temperature_milli, operation_id, dispatch_generation, state, governance_decision,
         effective_route_sha256, policy_revision, policy_sha256, approval_receipt_sha256,
         governance_output_token_ceiling, governance_reasoning_token_ceiling, governance_expires_at,
         budget_reservation_id, admitted_at, updated_at
       ) VALUES (
         @registryWorkspaceId, @assignmentId, @assignmentGeneration, @inferenceRequestId, @attempt,
         @workerId, @workerGeneration, @sessionId, @turnId, @idempotencyKey,
         @requestBodyJson, @requestSha256, @inputSha256, @contextSha256, @modelIntentSha256,
         @capabilityProfileSha256, @routedContextSha256, @outputTokenCeiling, @reasoningTokenCeiling,
         @temperatureMilli, @operationId, @dispatchGeneration, @state, @governanceDecision,
         @effectiveRouteSha256, @policyRevision, @policySha256, @approvalReceiptSha256,
         @governanceOutputTokenCeiling, @governanceReasoningTokenCeiling, @governanceExpiresAt,
         @budgetReservationId, @admittedAt, @admittedAt
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
  session_id: string;
  turn_id: string;
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
  budget_reservation_id: string;
  effective_provider_id: string | null;
  effective_model_id: string | null;
  dispatch_claim_owner: string | null;
  dispatch_claimed_at: string | null;
  dispatch_lease_expires_at: string | null;
  usage_intent_event_id: string | null;
  usage_terminal_event_id: string | null;
  output_frame_count: number | bigint | string;
  output_char_count: number | bigint | string;
  worker_acknowledged_through: number | bigint | string;
  terminal_frame_sequence: number | bigint | string | null;
  terminal_sha256: string | null;
  accounting_disposition: string | null;
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
    sessionId: row.session_id,
    turnId: row.turn_id,
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
    budgetReservationId: row.budget_reservation_id,
    ...(row.effective_provider_id === null ? {} : { effectiveProviderId: row.effective_provider_id }),
    ...(row.effective_model_id === null ? {} : { effectiveModelId: row.effective_model_id }),
    ...(row.dispatch_claim_owner === null ? {} : { dispatchClaimOwner: row.dispatch_claim_owner }),
    ...(row.dispatch_claimed_at === null ? {} : { dispatchClaimedAt: row.dispatch_claimed_at }),
    ...(row.dispatch_lease_expires_at === null ? {} : { dispatchLeaseExpiresAt: row.dispatch_lease_expires_at }),
    ...(row.usage_intent_event_id === null ? {} : { usageIntentEventId: row.usage_intent_event_id }),
    ...(row.usage_terminal_event_id === null ? {} : { usageTerminalEventId: row.usage_terminal_event_id }),
    outputFrameCount: asInt(row.output_frame_count),
    outputCharCount: asInt(row.output_char_count),
    workerAcknowledgedThrough: asInt(row.worker_acknowledged_through),
    ...(row.terminal_frame_sequence === null ? {} : { terminalFrameSequence: asInt(row.terminal_frame_sequence) }),
    ...(row.terminal_sha256 === null ? {} : { terminalSha256: row.terminal_sha256 }),
    ...(row.accounting_disposition === null
      ? {}
      : { accountingDisposition: row.accounting_disposition as "delegated" | "settled" | "unknown" }),
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
