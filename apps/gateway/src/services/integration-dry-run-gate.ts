import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ApprovalReplayEvent,
  DryRunCommitStore,
  DryRunPlannedAction,
  IntegrationActionInvokeInput,
  PendingApprovalAction,
  WardEffect,
} from "@goatcitadel/contracts";
import { commitDryRun, createDryRunPreview } from "./dry-run-commit-service.js";
import {
  type IdempotentExternalSideEffectRunInput,
  type IdempotentExternalSideEffectRunResult,
  runIdempotentExternalSideEffect,
} from "./external-side-effect-runner-service.js";
import type { IntegrationActionHost } from "./integration-action-service.js";

/**
 * Citadel Ward gating for integration operator actions (dry-run Stage 2).
 *
 * Stage 1 made `require_dry_run` refusals fail-closed at the side-effect runner. This module
 * closes the loop: a refusal opens a persisted dry-run PREVIEW of the exact planned action plus
 * an operator approval; the approval's replay handler re-invokes the action in commit mode, where
 * the owning write path re-derives the planned action from live state and `commitDryRun` refuses
 * — before the boundary — unless its hash matches the approved preview byte-for-byte.
 */

/** How long a dry-run approval stays actionable (matches the code-mode pending-approval TTL). */
const DRY_RUN_APPROVAL_TTL_MS = 15 * 60_000;

export const INTEGRATION_DRY_RUN_COMMIT_ACTION_TYPE = "integration.dry_run_commit" as const;

/** Ward decision + identity for one integration action invocation, built once by the dispatcher. */
export interface IntegrationWardContext {
  effect?: WardEffect;
  /** Ward action name, e.g. `integration.automation.gmail.write`. Doubles as the planned route. */
  action: string;
  citadelId: string;
  /** The original invoke request — persisted so the commit replay re-derives the same payload. */
  invokeRequest: IntegrationActionInvokeInput;
  /** Present when replaying an operator-approved dry-run commit. */
  dryRunCommit?: IntegrationDryRunCommitRef;
}

export interface IntegrationDryRunCommitRef {
  dryRunId: string;
  approvedBy?: string;
}

/** Carries a structured runner result out of `commitDryRun`'s execute without losing its shape. */
class DryRunCommitInnerResultError<TValue> extends Error {
  public constructor(public readonly result: IdempotentExternalSideEffectRunResult<TValue>) {
    super(
      result.status === "failed"
        ? result.error.message
        : result.status === "blocked"
          ? result.message
          : "dry_run_commit_inner_result",
    );
  }
}

type BlockedRunResult<TValue> = Extract<IdempotentExternalSideEffectRunResult<TValue>, { status: "blocked" }>;
type ExecutedRunResult<TValue> = Extract<IdempotentExternalSideEffectRunResult<TValue>, { status: "executed" }>;
/** What a hash-matched commit may hand back across the boundary seam: a real execution, or the
 * idempotency layer's proof that this exact payload already crossed (duplicate). */
type CommitBoundaryValue<TValue> = ExecutedRunResult<TValue> | BlockedRunResult<TValue>;

export interface WardGateRunOptions {
  /**
   * The resolved external endpoint this action would hit (webhook URL, bridge URL, provider API
   * URL). Folded — sanitized to origin+path — into the hashed planned action so an endpoint edit
   * between preview and approval refuses the commit instead of sending the approved payload to a
   * different destination.
   */
  externalDestination?: string;
}

/**
 * The single runner entry point for ward-gated integration write paths.
 *
 * - Approved commit replay (`ward.dryRunCommit`) → hash-verified `commitDryRun` around the runner.
 * - `require_dry_run` refusal → open a preview + approval and surface `dryRunId`/`approvalId`.
 * - Everything else → the plain idempotent runner, unchanged.
 */
export async function runWardGatedExternalSideEffect<TValue>(
  host: IntegrationActionHost,
  ward: IntegrationWardContext | undefined,
  input: IdempotentExternalSideEffectRunInput<TValue>,
  gateOptions: WardGateRunOptions = {},
): Promise<IdempotentExternalSideEffectRunResult<TValue>> {
  if (ward?.dryRunCommit) {
    return commitApprovedDryRunSideEffect(host, ward, ward.dryRunCommit, input, gateOptions);
  }
  const result = await runIdempotentExternalSideEffect({ ...input, wardEffect: ward?.effect });
  if (ward && result.status === "blocked" && result.blockedReason === "external_side_effect_dry_run_required") {
    return openDryRunPreviewForWardRefusal(host, ward, input, result, gateOptions);
  }
  return result;
}

/**
 * Persist the refused action as an awaiting-commit dry-run preview and register an operator
 * approval whose replay commits it. Hosts without the ledger/approval members keep Stage 1
 * behavior: the refusal stands, block-only.
 */
async function openDryRunPreviewForWardRefusal<TValue>(
  host: IntegrationActionHost,
  ward: IntegrationWardContext,
  input: IdempotentExternalSideEffectRunInput<TValue>,
  refusal: BlockedRunResult<TValue>,
  gateOptions: WardGateRunOptions,
): Promise<BlockedRunResult<TValue>> {
  const store = host.storage.dryRunCommits;
  const pendingActions = host.storage.pendingApprovalActions;
  const createApproval = host.createApproval;
  if (!store || !pendingActions || !createApproval || !input.connectionId || !input.actionId) {
    return refusal;
  }
  let record: ReturnType<typeof createDryRunPreview>;
  try {
    record = createDryRunPreview(store, {
      runId: refusal.claim.sideEffectRunId ?? refusal.claim.idempotencyKey,
      boundary: input.boundary,
      plannedAction: buildIntegrationPlannedAction(ward, input, gateOptions),
      payloadHash: refusal.claim.payloadHash,
      workspaceId: input.workspaceId,
      createdAt: input.checkedAt,
    });
  } catch (error) {
    // A ledger write failure must not escalate a fail-closed refusal into a thrown
    // request error; the refusal stands (block-only) and says why no preview opened.
    return {
      ...refusal,
      output: {
        ...refusal.output,
        dryRunLedgerError: error instanceof Error ? error.message : "dry_run_preview_persist_failed",
      },
    };
  }
  try {
    const expiresAt = new Date(Date.parse(input.checkedAt) + DRY_RUN_APPROVAL_TTL_MS).toISOString();
    const approval = await createApproval({
      kind: INTEGRATION_DRY_RUN_COMMIT_ACTION_TYPE,
      riskLevel: "caution",
      payload: {
        dryRunId: record.dryRunId,
        connectionId: input.connectionId,
        catalogId: input.catalogId,
        actionId: input.actionId,
        wardAction: ward.action,
        citadelId: ward.citadelId,
        workspaceId: input.workspaceId,
        input: ward.invokeRequest.input ?? {},
      },
      preview: {
        title: `${input.label} — dry-run preview awaiting commit`,
        route: record.plannedAction.route,
        target: record.plannedAction.target,
        payload: record.plannedAction.payload,
        dryRunHash: record.dryRunHash,
      },
      linkage: {
        workspaceId: input.workspaceId,
        actionType: INTEGRATION_DRY_RUN_COMMIT_ACTION_TYPE,
      },
      expiresAt,
    });
    pendingActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: INTEGRATION_DRY_RUN_COMMIT_ACTION_TYPE,
      request: {
        dryRunId: record.dryRunId,
        connectionId: input.connectionId,
        actionId: input.actionId,
        workspaceId: input.workspaceId,
        invokeRequest: {
          input: ward.invokeRequest.input ?? {},
          ...(ward.invokeRequest.idempotencyKey ? { idempotencyKey: ward.invokeRequest.idempotencyKey } : {}),
        },
      },
      createdAt: input.checkedAt,
      expiresAt,
    });
    host.storage.approvalEvents?.append({
      approvalId: approval.approvalId,
      eventType: "pending_action_registered",
      actorId: "system",
      payload: {
        actionType: INTEGRATION_DRY_RUN_COMMIT_ACTION_TYPE,
        dryRunId: record.dryRunId,
        connectionId: input.connectionId,
        actionId: input.actionId,
        wardAction: ward.action,
        citadelId: ward.citadelId,
      },
    });
    return {
      ...refusal,
      message: `${refusal.message} A dry-run preview of the exact planned action is awaiting operator approval.`,
      output: {
        ...refusal.output,
        dryRunId: record.dryRunId,
        dryRunHash: record.dryRunHash,
        dryRunState: record.state,
        approvalId: approval.approvalId,
      },
    };
  } catch (error) {
    // The preview exists but no approval could be registered; the refusal stands and says why.
    return {
      ...refusal,
      output: {
        ...refusal.output,
        dryRunId: record.dryRunId,
        dryRunState: record.state,
        approvalError: error instanceof Error ? error.message : "dry_run_approval_create_failed",
      },
    };
  }
}

/**
 * Commit an operator-approved dry-run: rebuild the planned action from LIVE state (never from
 * the stored preview — that would defeat the moat), let `commitDryRun` compare hashes, and only
 * on a match run the normal idempotent runner across the boundary.
 */
async function commitApprovedDryRunSideEffect<TValue>(
  host: IntegrationActionHost,
  ward: IntegrationWardContext,
  commitRef: IntegrationDryRunCommitRef,
  input: IdempotentExternalSideEffectRunInput<TValue>,
  gateOptions: WardGateRunOptions,
): Promise<IdempotentExternalSideEffectRunResult<TValue>> {
  const store = host.storage.dryRunCommits;
  if (!store) {
    return refuseCommitPreBoundary(input, {
      blockedReason: "dry_run_commit_store_unavailable",
      message: `${input.label} commit refused: the dry-run ledger is unavailable, so the approved preview cannot be verified.`,
      dryRunId: commitRef.dryRunId,
    });
  }
  const committedAction = buildIntegrationPlannedAction(ward, input, gateOptions);
  let commit: Awaited<ReturnType<typeof commitDryRun<CommitBoundaryValue<TValue>>>>;
  try {
    commit = await commitDryRun<CommitBoundaryValue<TValue>>(store, {
      dryRunId: commitRef.dryRunId,
      committedAction,
      committedAt: input.checkedAt,
      async execute(context) {
        const result = await runIdempotentExternalSideEffect({ ...input, wardEffect: undefined });
        if (result.status === "executed") {
          context.markExternalCallStarted();
          return result;
        }
        if (result.status === "blocked" && result.blockedReason === "external_side_effect_duplicate") {
          // This exact payload+key already crossed the boundary (an earlier commit
          // attempt sent it and died before bookkeeping). The moat's at-most-once
          // guarantee held — record the commit instead of terminalizing it as failed.
          context.markExternalCallStarted();
          return result;
        }
        if (result.status === "failed" && result.claim.resumeState === "manual_review_unknown_external_outcome") {
          context.markExternalCallStarted();
        }
        throw new DryRunCommitInnerResultError(result);
      },
    });
  } catch (error) {
    // commitDryRun throws only for an unknown dryRunId; nothing has crossed the boundary.
    return refuseCommitPreBoundary(input, {
      blockedReason: "dry_run_commit_unknown_preview",
      message: error instanceof Error ? error.message : "dry-run commit refused: unknown preview.",
      dryRunId: commitRef.dryRunId,
    });
  }
  if (commit.status === "committed") {
    return commit.value;
  }
  if (commit.status === "failed" && commit.error instanceof DryRunCommitInnerResultError) {
    const inner = (commit.error as DryRunCommitInnerResultError<TValue>).result;
    if (inner.status === "blocked" && inner.blockedReason === "external_side_effect_in_progress") {
      // A concurrent commit attempt for this approval is still mid-flight; this retry
      // must not terminalize the approved preview. Restore awaiting_commit (approval
      // and hash kept) so the in-flight attempt — or a later retry — can conclude it.
      // Conditional on the state THIS attempt just wrote: if the in-flight attempt's
      // "committed" (or any other) update has already landed, leave it alone — an
      // unconditional restore would stomp a genuinely committed record back to
      // awaiting_commit.
      if (store.get(commitRef.dryRunId)?.state === "rejected_commit_failed") {
        store.update(commitRef.dryRunId, {
          state: "awaiting_commit",
          diagnostic: {
            code: "commit_execution_failed",
            message:
              "Commit retry observed another attempt in progress for the same idempotency key; the preview was restored to awaiting_commit.",
            recordedAt: input.checkedAt,
          },
          updatedAt: input.checkedAt,
        });
      }
    }
    // The hash matched; the runner itself blocked or failed. Surface its structured result.
    return inner;
  }
  return refuseCommitPreBoundary(input, {
    blockedReason: `dry_run_commit_${commit.diagnostic.code}`,
    message: commit.diagnostic.message,
    dryRunId: commitRef.dryRunId,
    extraOutput: {
      dryRunState: commit.record.state,
      ...(commit.diagnostic.approvedDryRunHash ? { approvedDryRunHash: commit.diagnostic.approvedDryRunHash } : {}),
      ...(commit.diagnostic.attemptedCommitHash ? { attemptedCommitHash: commit.diagnostic.attemptedCommitHash } : {}),
    },
  });
}

/**
 * Produce an honest pre-boundary refusal for a commit that could not run. Reuses the runner's
 * own `require_dry_run` refusal so the block is recorded in the external side-effect ledger with
 * a real claim, then relabels the reason with the commit diagnostic.
 */
async function refuseCommitPreBoundary<TValue>(
  input: IdempotentExternalSideEffectRunInput<TValue>,
  detail: { blockedReason: string; message: string; dryRunId: string; extraOutput?: Record<string, unknown> },
): Promise<IdempotentExternalSideEffectRunResult<TValue>> {
  const refusal = await runIdempotentExternalSideEffect({ ...input, wardEffect: "require_dry_run" });
  if (refusal.status !== "blocked") {
    return refusal;
  }
  return {
    ...refusal,
    message: detail.message,
    blockedReason: detail.blockedReason,
    output: {
      ...refusal.output,
      dryRunId: detail.dryRunId,
      ...(detail.extraOutput ?? {}),
    },
  };
}

/**
 * The hashed contract between preview and commit: ward action name as the route, the concrete
 * connection:action (+ the sanitized resolved endpoint) as the target, and the exact runner
 * payload. Built from live inputs on BOTH sides so any drift — changed config default, edited
 * input, or a rewired destination URL — breaks the hash and refuses the commit.
 */
function buildIntegrationPlannedAction(
  ward: IntegrationWardContext,
  input: IdempotentExternalSideEffectRunInput<unknown>,
  gateOptions: WardGateRunOptions,
): DryRunPlannedAction {
  const destination = sanitizeExternalDestination(gateOptions.externalDestination);
  return {
    route: ward.action,
    target: `${input.connectionId ?? "unknown_connection"}:${input.actionId ?? "unknown_action"}${
      destination ? `@${destination}` : ""
    }`,
    payload: input.payload,
  };
}

/**
 * Origin + path only: enough to pin WHERE the approved payload will be sent (host/route swaps
 * refuse the commit) without persisting query-string credentials into the preview/ledger.
 */
function sanitizeExternalDestination(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return trimmed;
  }
}

/** Structural slices of the approval stores the host may optionally provide (Stage 2). */
export interface IntegrationDryRunApprovalStores {
  dryRunCommits?: DryRunCommitStore;
  pendingApprovalActions?: {
    upsertPending(input: {
      approvalId: string;
      actionType: PendingApprovalAction["actionType"];
      request: Record<string, unknown>;
      createdAt?: string;
      expiresAt?: string;
    }): PendingApprovalAction;
  };
  approvalEvents?: {
    append(input: {
      approvalId: string;
      eventType: ApprovalReplayEvent["eventType"];
      actorId: string;
      payload: Record<string, unknown>;
    }): unknown;
  };
}

export type IntegrationDryRunApprovalCreate = (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
