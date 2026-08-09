import {
  normalizeRemoteWorkerInferenceRequestSubmission,
  remoteWorkerInferenceLeaseTokenSha256,
  type RemoteWorkerInferenceBudgetReservation,
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

/**
 * HX-503 assignment-bound inference service (production-dark).
 *
 * Performs model inference for one already-admitted, actively leased
 * remote-worker assignment. It is not a route, listener, scheduler, provider
 * adapter, or a second accounting owner. Every governance, budget, authority,
 * routing, adapter, and accounting collaborator is injected so the owner is
 * proven single-host with deterministic doubles; live enablement (a listener,
 * an atomic budget adapter, and the verify:remote-workers lane) is a later,
 * separately gated row.
 *
 * The service hashes the raw lease immediately and never persists or logs it,
 * verifies the authenticated worker_runtime + gateway_inference claims,
 * revalidates the full authority chain, chooses the effective provider/model
 * and owns every credential, delegates attempt/usage/outcome/cost truth to
 * HX-306, and persists canonical output frames plus terminal evidence before
 * worker delivery.
 */

export const REMOTE_WORKER_INFERENCE_REQUIRED_CLAIMS = ["worker_runtime", "gateway_inference"] as const;

type Awaitable<T> = T | Promise<T>;
type AwaitableRepositoryMethod<Method> = Method extends (...args: infer Args) => infer Result
  ? (...args: Args) => Awaitable<Result>
  : never;

type RemoteWorkerInferenceRepositoryMethod =
  | "admitOrReplay"
  | "claimDispatch"
  | "appendOutputFrame"
  | "markDispatchUnknown"
  | "finalizeTerminal"
  | "acknowledge"
  | "getRequest"
  | "listFramesAfter";

/** Promise-compatible owner boundary used by the Gateway AsyncStorage graph. */
export type RemoteWorkerInferenceRepositoryPort = {
  readonly [Method in RemoteWorkerInferenceRepositoryMethod]: AwaitableRepositoryMethod<
    RemoteWorkerInferenceRepository[Method]
  >;
};

export interface RemoteWorkerInferenceResolvedAuthority {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly leaseRevision: number;
  readonly capabilityProfileSha256: string;
  readonly routedContextSha256: string;
}

export interface RemoteWorkerInferenceAuthorityPort {
  /**
   * Re-resolve the active lease authority by the hashed lease. Returns
   * `undefined` when the lease is unknown, stale, or not fresh; throws on
   * cancellation or a terminal generation.
   */
  resolveActiveAuthority(input: {
    leaseTokenSha256: string;
  }): Awaitable<RemoteWorkerInferenceResolvedAuthority | undefined>;
}

export interface RemoteWorkerInferenceGovernanceRequest {
  readonly authority: RemoteWorkerInferenceResolvedAuthority;
  readonly submission: RemoteWorkerInferenceRequestSubmission;
}

export interface RemoteWorkerInferenceGovernancePort {
  evaluate(input: RemoteWorkerInferenceGovernanceRequest): Awaitable<RemoteWorkerInferenceGovernanceReceipt>;
}

export interface RemoteWorkerInferenceBudgetReserveRequest {
  readonly authority: RemoteWorkerInferenceResolvedAuthority;
  readonly governance: RemoteWorkerInferenceGovernanceReceipt;
  readonly requestedOutputTokens: number;
}

export interface RemoteWorkerInferenceBudgetPort {
  /** Idempotent reservation; `undefined` is a fail-closed budget denial. */
  reserve(
    input: RemoteWorkerInferenceBudgetReserveRequest,
  ): Awaitable<RemoteWorkerInferenceBudgetReservation | undefined>;
  /** Settle only from HX-306 event ids. */
  settle(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    usageEventIds: readonly string[];
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
  readonly budget: RemoteWorkerInferenceBudgetPort;
  readonly routing: RemoteWorkerInferenceRoutingPort;
  readonly adapter: RemoteWorkerInferenceDispatchAdapter;
  readonly dispatchOwnerId: string;
  readonly clock: () => string;
  readonly operationIdFor?: (submission: RemoteWorkerInferenceRequestSubmission) => string;
  readonly dispatchGenerationFor?: (submission: RemoteWorkerInferenceRequestSubmission) => string;
}

export interface RemoteWorkerInferencePerformInput {
  readonly submission: RemoteWorkerInferenceRequestSubmission;
  readonly workerCapabilityClaims: readonly string[];
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

/** Authority/credential/capability failure with no request side effect. */
export class RemoteWorkerInferenceAccessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerInferenceAccessError";
  }
}

export class RemoteWorkerInferenceService {
  public constructor(private readonly options: RemoteWorkerInferenceServiceOptions) {}

  public async performInference(
    input: RemoteWorkerInferencePerformInput,
  ): Promise<RemoteWorkerInferencePerformOutcome> {
    const submission = normalizeRemoteWorkerInferenceRequestSubmission(input.submission);
    this.assertCapabilityClaims(input.workerCapabilityClaims);

    // Boundary 1: hash the raw lease immediately, then resolve + verify authority.
    const leaseTokenSha256 = remoteWorkerInferenceLeaseTokenSha256(input.submission.leaseToken);
    const authority = await this.resolveAuthorityOrThrow(leaseTokenSha256);
    this.assertAuthorityBinding(authority, submission, "admission");

    // Boundary 2: secret-free governance + atomic budget decisions (fail closed).
    const governance = await this.options.governance.evaluate({ authority, submission: input.submission });
    const reservation = await this.options.budget.reserve({
      authority,
      governance,
      requestedOutputTokens: submission.outputTokenCeiling,
    });
    if (!reservation) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference budget reservation was denied.");
    }

    // Boundary 3: insert or exactly replay the request.
    const admission = await this.options.repository.admitOrReplay({
      submission: input.submission,
      workerId: authority.workerId,
      workerGeneration: authority.workerGeneration,
      sessionId: authority.sessionId!,
      turnId: authority.turnId!,
      capabilityProfileSha256: authority.capabilityProfileSha256,
      routedContextSha256: authority.routedContextSha256,
      operationId: this.operationId(input.submission),
      dispatchGeneration: this.dispatchGeneration(input.submission),
      governance,
      budgetReservationId: reservation.reservationId,
      admittedAt: this.options.clock(),
    });
    const key = keyOf(admission.request);

    if (governance.decision === "denied") {
      return await this.finish("blocked", key);
    }
    if (governance.decision === "approval_required") {
      return await this.finish("waiting_approval", key);
    }
    if (admission.disposition === "replayed" && admission.request.state !== "admitted") {
      // Idempotent replay of an already-dispatched request: never re-invoke the
      // provider; return the durable outbox.
      return await this.finish("replayed", key);
    }

    // Boundary 4: re-resolve authority (drift) and take the one-winner claim.
    const revalidated = await this.resolveAuthorityOrThrow(leaseTokenSha256);
    this.assertAuthorityBinding(revalidated, submission, "dispatch");
    this.assertNoDrift(revalidated, admission.request);
    const resolution = await this.options.routing.resolve({ authority: revalidated, governance });
    const claimed = await this.options.repository.claimDispatch({
      ...key,
      dispatchClaimOwner: this.options.dispatchOwnerId,
      effectiveProviderId: resolution.providerId,
      effectiveModelId: resolution.modelId,
      usageIntentEventId: `intent:${resolution.providerId}:${admission.request.operationId}`,
      dispatchLeaseExpiresAt: governance.expiresAt,
      now: this.options.clock(),
    });
    if (!claimed) {
      return await this.finish("lost_claim", key);
    }

    // Boundary 5 + 6: dispatch outside the database and persist each frame.
    const outcome = await this.options.adapter.dispatch({
      attribution: {
        callKind: "delegation_worker",
        operationId: admission.request.operationId,
        dispatchGeneration: admission.request.dispatchGeneration,
        workspaceId: authority.registryWorkspaceId,
        sessionId: authority.sessionId!,
        turnId: authority.turnId!,
        workerId: authority.workerId,
      },
      resolution,
      messages: submission.messages,
      requestedOutputTokenCap: submission.outputTokenCeiling,
      effectiveOutputTokenCap: Math.min(submission.outputTokenCeiling, governance.outputTokenCeiling),
      reasoningTokenCeiling: Math.min(submission.reasoningTokenCeiling, governance.reasoningTokenCeiling),
      temperatureMilli: submission.temperatureMilli,
    });

    for (const text of outcome.chunks) {
      if (text.length === 0) continue;
      await this.options.repository.appendOutputFrame({
        ...key,
        dispatchClaimOwner: this.options.dispatchOwnerId,
        text,
        now: this.options.clock(),
      });
    }

    // Boundary 7 + 8: consume HX-306 truth, finalize, and settle from event ids.
    if (outcome.terminalState === "dispatch_unknown") {
      await this.options.repository.markDispatchUnknown(key, {
        dispatchClaimOwner: this.options.dispatchOwnerId,
        usageTerminalEventId: outcome.usageEventId,
        now: this.options.clock(),
      });
      await this.options.budget.settle({ reservation, usageEventIds: outcome.usageEventIds });
      return await this.finish("dispatch_unknown", key);
    }

    await this.options.repository.finalizeTerminal({
      ...key,
      dispatchClaimOwner: this.options.dispatchOwnerId,
      terminalState: outcome.terminalState,
      usageTerminalEventId: outcome.usageEventId,
      now: this.options.clock(),
    });
    await this.options.budget.settle({ reservation, usageEventIds: outcome.usageEventIds });
    return await this.finish(dispositionFor(outcome.terminalState), key);
  }

  /**
   * Boundary 9: a reconnecting worker reads the durable outbox after its
   * acknowledgement watermark. Authority is revalidated on every read; a lost
   * authority blocks stale delivery while preserving the persisted evidence.
   */
  public async readPendingFrames(input: {
    submission: Pick<
      RemoteWorkerInferenceRequestSubmission,
      "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "inferenceRequestId" | "attempt" | "leaseToken"
    >;
    workerCapabilityClaims: readonly string[];
  }): Promise<readonly RemoteWorkerInferenceFrameRecord[]> {
    this.assertCapabilityClaims(input.workerCapabilityClaims);
    const leaseTokenSha256 = remoteWorkerInferenceLeaseTokenSha256(input.submission.leaseToken);
    await this.resolveAuthorityOrThrow(leaseTokenSha256);
    const key = keyFromParts(input.submission);
    const request = await this.requireRequest(key);
    return await this.options.repository.listFramesAfter(key, request.workerAcknowledgedThrough);
  }

  /** Boundary 9: advance the acknowledgement watermark after revalidating authority. */
  public async acknowledge(input: {
    submission: Pick<
      RemoteWorkerInferenceRequestSubmission,
      "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "inferenceRequestId" | "attempt" | "leaseToken"
    >;
    workerCapabilityClaims: readonly string[];
    throughSequence: number;
  }): Promise<RemoteWorkerInferenceRequestRecord> {
    this.assertCapabilityClaims(input.workerCapabilityClaims);
    const leaseTokenSha256 = remoteWorkerInferenceLeaseTokenSha256(input.submission.leaseToken);
    await this.resolveAuthorityOrThrow(leaseTokenSha256);
    const key = keyFromParts(input.submission);
    return await this.options.repository.acknowledge(key, input.throughSequence, this.options.clock());
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
    } catch (cause) {
      throw new RemoteWorkerInferenceAccessError(
        `Remote worker inference authority is cancelled or terminal: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!authority) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference lease is unknown, stale, or expired.");
    }
    return authority;
  }

  private assertAuthorityBinding(
    authority: RemoteWorkerInferenceResolvedAuthority,
    submission: RemoteWorkerInferenceRequestSubmission,
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
    if (authority.sessionId === undefined || authority.turnId === undefined) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference rejects a sessionless assignment in V1.");
    }
    if (authority.routedContextSha256 !== submission.contextSha256) {
      throw new RemoteWorkerInferenceAccessError(`Remote worker inference routed-context hash drifted at ${phase}.`);
    }
  }

  private assertNoDrift(
    authority: RemoteWorkerInferenceResolvedAuthority,
    request: RemoteWorkerInferenceRequestRecord,
  ): void {
    if (
      authority.workerGeneration !== request.workerGeneration ||
      authority.capabilityProfileSha256 !== request.capabilityProfileSha256 ||
      authority.routedContextSha256 !== request.routedContextSha256
    ) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference authority drifted after admission.");
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
    if (!request) {
      throw new RemoteWorkerInferenceAccessError("Remote worker inference request not found.");
    }
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
