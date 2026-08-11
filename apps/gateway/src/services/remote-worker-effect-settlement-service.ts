import {
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  type RemoteWorkerEffectCorrelation,
  type RemoteWorkerEffectReceiptState,
  type RemoteWorkerEffectTransitionState,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerEffectReceiptRecord,
  RemoteWorkerEffectRepository,
  RemoteWorkerEffectTransitionRecord,
} from "@goatcitadel/storage";
import type { AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

/**
 * HX-506 effect settlement service (production-dark).
 *
 * The worker supplies ONLY a bounded effect/tool selector, canonical args, and
 * an idempotency key. Gateway derives workspace, session, agent, policy context,
 * approval identity, runtime owner, profile, posture, and secrets.
 *
 * 1. Persist the immutable remote intent BEFORE policy or delivery.
 * 2. Invoke only through the canonical coordinator with an assignment/HX-411
 *    execution fence and the canonical external-side-effect boundary.
 * 3. Record ONLY exact correlations to the owner's approval/boundary/HX-305/
 *    reconciliation evidence. A completed_with_effect requires an exact completed
 *    HX-305 canonical owner; a result payload never creates a receipt.
 *
 * This service never extends external_side_effect_runs, accepts no worker-
 * reported usage/cost, and never recomputes HX-306. Authority loss after the
 * boundary records actual completion or ambiguity but cannot retry.
 */

export interface RemoteWorkerEffectExecutionFence {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  sessionControlGeneration: number | null;
  leaseTokenSha256: string;
}

export type RemoteWorkerEffectDispatchOutcome =
  | {
      kind: "blocked_before_dispatch";
      approvalRecordSha256: string | null;
      sanitizedError: string;
      approvalWaited?: boolean;
    }
  | { kind: "failed_before_boundary"; sanitizedError: string; approvalWaited?: boolean }
  | {
      kind: "completed_no_effect";
      externalSideEffectRunId: string;
      boundaryReceiptSha256: string;
      approvalRecordSha256?: string | null;
    }
  | {
      kind: "completed_with_effect";
      externalSideEffectRunId: string;
      boundaryReceiptSha256: string;
      hx305OutcomeSha256: string;
      approvalRecordSha256?: string | null;
    }
  | {
      kind: "manual_reconciliation";
      externalSideEffectRunId: string;
      boundaryReceiptSha256: string | null;
      sanitizedError: string;
      approvalRecordSha256?: string | null;
    };

export interface RemoteWorkerEffectCoordinatorPort {
  /**
   * Invokes the canonical external-effect runner + tool coordinator with the
   * generation/HX-411 fence and the canonical boundary. Returns the owner's exact
   * evidence; the coordinator — not this service — durably claims the boundary and
   * owns HX-305/HX-306. Loss of authority before the boundary blocks delivery.
   */
  dispatch(input: {
    fence: RemoteWorkerEffectExecutionFence;
    effectSelector: string;
    canonicalArgsSha256: string;
    workerIdempotencyKey: string;
  }): Promise<RemoteWorkerEffectDispatchOutcome>;
}

export interface RemoteWorkerEffectSettlementDependencies {
  repository: RemoteWorkerEffectRepositoryPort;
  coordinator: RemoteWorkerEffectCoordinatorPort;
}

type RemoteWorkerEffectRepositoryMethod = "recordIntent" | "appendTransition" | "recordReceipt";

export type RemoteWorkerEffectRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerEffectRepository,
  RemoteWorkerEffectRepositoryMethod
>;

export interface DispatchRemoteWorkerEffectInput {
  fence: RemoteWorkerEffectExecutionFence;
  intentIndex: number;
  effectSelector: string;
  canonicalArgs: unknown;
  workerIdempotencyKey: string;
  intentIdempotencyKey: string;
}

export interface DispatchRemoteWorkerEffectResult {
  intentId: string;
  transitions: RemoteWorkerEffectTransitionRecord[];
  receipt: RemoteWorkerEffectReceiptRecord;
}

export class RemoteWorkerEffectSettlementService {
  private readonly repository: RemoteWorkerEffectRepositoryPort;
  private readonly coordinator: RemoteWorkerEffectCoordinatorPort;

  public constructor(dependencies: RemoteWorkerEffectSettlementDependencies) {
    this.repository = dependencies.repository;
    this.coordinator = dependencies.coordinator;
  }

  public async dispatchEffect(input: DispatchRemoteWorkerEffectInput): Promise<DispatchRemoteWorkerEffectResult> {
    const { fence } = input;
    // 1. Persist the immutable remote intent BEFORE any policy or delivery.
    const intent = await this.repository.recordIntent({
      registryWorkspaceId: fence.registryWorkspaceId,
      assignmentId: fence.assignmentId,
      assignmentGeneration: fence.assignmentGeneration,
      intentIndex: input.intentIndex,
      effectSelector: input.effectSelector,
      canonicalArgs: input.canonicalArgs,
      workerIdempotencyKey: input.workerIdempotencyKey,
      idempotencyKey: input.intentIdempotencyKey,
    });

    const transitions: RemoteWorkerEffectTransitionRecord[] = [];
    let sequence = 0;
    const append = async (
      state: RemoteWorkerEffectTransitionState,
      correlation: Omit<RemoteWorkerEffectCorrelation, "schemaVersion" | "transitionState">,
    ): Promise<void> => {
      sequence += 1;
      transitions.push(
        await this.repository.appendTransition({
          registryWorkspaceId: fence.registryWorkspaceId,
          assignmentId: fence.assignmentId,
          assignmentGeneration: fence.assignmentGeneration,
          intentId: intent.intentId,
          correlation: {
            schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
            transitionState: state,
            ...correlation,
          },
          idempotencyKey: `${input.intentIdempotencyKey}:t${sequence}`,
        }),
      );
    };

    // Genesis correlation records the intent before delivery.
    await append("recorded", emptyCorrelation());

    // 2. Invoke ONLY through the canonical coordinator with the execution fence.
    const outcome = await this.coordinator.dispatch({
      fence,
      effectSelector: input.effectSelector,
      canonicalArgsSha256: intent.canonicalArgsSha256,
      workerIdempotencyKey: input.workerIdempotencyKey,
    });

    // 3. Record ONLY exact correlations to the coordinator's evidence.
    const receiptState = await this.recordOutcome(append, outcome);
    const terminal = transitions[transitions.length - 1]!;

    const receipt = await this.repository.recordReceipt({
      registryWorkspaceId: fence.registryWorkspaceId,
      assignmentId: fence.assignmentId,
      assignmentGeneration: fence.assignmentGeneration,
      intentId: intent.intentId,
      receiptState,
      finalTransitionSequence: terminal.transitionSequence,
      finalTransitionSha256: terminal.transitionSha256,
      hx305OutcomeSha256: outcome.kind === "completed_with_effect" ? outcome.hx305OutcomeSha256 : null,
      idempotencyKey: `${input.intentIdempotencyKey}:receipt`,
    });

    return { intentId: intent.intentId, transitions, receipt };
  }

  private async recordOutcome(
    append: (
      state: RemoteWorkerEffectTransitionState,
      correlation: Omit<RemoteWorkerEffectCorrelation, "schemaVersion" | "transitionState">,
    ) => Promise<void>,
    outcome: RemoteWorkerEffectDispatchOutcome,
  ): Promise<RemoteWorkerEffectReceiptState> {
    const approvalRecordSha256 = "approvalRecordSha256" in outcome ? (outcome.approvalRecordSha256 ?? null) : null;
    if ("approvalWaited" in outcome && outcome.approvalWaited) {
      await append("approval_wait", { ...emptyCorrelation(), approvalRecordSha256 });
    }
    switch (outcome.kind) {
      case "blocked_before_dispatch":
        await append("blocked_before_dispatch", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          sanitizedError: outcome.sanitizedError,
        });
        return "blocked_before_dispatch";
      case "failed_before_boundary":
        await append("dispatch_claimed", emptyCorrelation());
        await append("failed_before_boundary", { ...emptyCorrelation(), sanitizedError: outcome.sanitizedError });
        return "failed_before_boundary";
      case "completed_no_effect":
        await append("dispatch_claimed", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
        });
        await append("external_boundary_started", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
          boundaryReceiptSha256: outcome.boundaryReceiptSha256,
        });
        await append("completed_no_effect", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
          boundaryReceiptSha256: outcome.boundaryReceiptSha256,
        });
        return "completed_no_effect";
      case "completed_with_effect":
        await append("dispatch_claimed", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
        });
        await append("external_boundary_started", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
          boundaryReceiptSha256: outcome.boundaryReceiptSha256,
        });
        // completed_with_effect REQUIRES the canonical HX-305 outcome the
        // coordinator supplies; the contract rejects a result-body-only receipt.
        await append("completed_with_effect", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
          boundaryReceiptSha256: outcome.boundaryReceiptSha256,
          hx305OutcomeSha256: outcome.hx305OutcomeSha256,
        });
        return "completed_with_effect";
      case "manual_reconciliation":
        // Any possibly-dispatched error becomes manual reconciliation; no retry.
        await append("dispatch_claimed", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
        });
        await append("manual_reconciliation", {
          ...emptyCorrelation(),
          approvalRecordSha256,
          externalSideEffectRunId: outcome.externalSideEffectRunId,
          boundaryReceiptSha256: outcome.boundaryReceiptSha256,
          sanitizedError: outcome.sanitizedError,
        });
        return "manual_reconciliation";
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unknown remote worker effect outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function emptyCorrelation(): Omit<RemoteWorkerEffectCorrelation, "schemaVersion" | "transitionState"> {
  return {
    externalSideEffectRunId: null,
    approvalRecordSha256: null,
    boundaryReceiptSha256: null,
    hx305OutcomeSha256: null,
    reconciliationRecordSha256: null,
    sanitizedError: null,
  };
}
