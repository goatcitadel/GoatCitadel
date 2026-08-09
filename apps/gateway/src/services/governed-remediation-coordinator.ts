import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ConflictError,
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  NotFoundError,
  canonicalJsonString,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationApplicationReceipt,
  type GovernedRemediationActivationReceipt,
  type GovernedRemediationFailure,
  type GovernedRemediationFailurePhase,
  type GovernedRemediationFailureReason,
  type GovernedRemediationPhase,
  type GovernedRemediationPhaseClaim,
  type GovernedRemediationReceipt,
  type GovernedRemediationReconciliation,
  type GovernedRemediationReconciliationDomain,
  type GovernedRemediationReconciliationObservation,
  type GovernedRemediationReconciliationResolution,
  type GovernedRemediationScope,
  type GovernedRemediationState,
  type GovernedRemediationStateRecord,
  type GovernedRemediationVerificationReceipt,
} from "@goatcitadel/contracts";
import {
  GovernedRemediationRepository,
  type GovernedRemediationClaimedPhaseOutcome,
  type GovernedRemediationClaimedPhasePublicationResult,
  type GovernedRemediationPhaseClaimAcquireResult,
  type GovernedRemediationReconciliationRecoveryCursor,
  type GovernedRemediationStateRecoveryCursor,
  type GovernedRemediationStoredState,
} from "@goatcitadel/storage";
import {
  GovernedRemediationRecipeRegistry,
  GovernedRemediationRegistryError,
  normalizeGovernedRemediationActivationResult,
  normalizeGovernedRemediationApplyResult,
  normalizeGovernedRemediationPreflightResult,
  normalizeGovernedRemediationProbeResult,
  normalizeGovernedRemediationReconcileResult,
  normalizeGovernedRemediationRollbackResult,
  type GovernedRemediationOwnerContext,
  type GovernedRemediationRecipeResolution,
} from "./governed-remediation-registry.js";

export type GovernedRemediationAuthorityPhase =
  | "preflight"
  | "apply"
  | "probe"
  | "activate"
  | "rollback"
  | "resume"
  | "effect_reconcile"
  | "resume_reconcile";

export type GovernedRemediationApprovalPurpose = "pre_effect" | "activation" | null;

/** Exact, secret-free policy envelope. Approval IDs never cross phase purposes. */
export interface GovernedRemediationAuthorityRequest {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceTurnId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly stateRevision: number;
  readonly phaseAggregateKind: "state" | "reconciliation";
  readonly phaseAggregateId: string;
  readonly phaseAggregateRevision: number;
  readonly operationId: string;
  readonly phase: GovernedRemediationAuthorityPhase;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly requestedCapabilityId: string;
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
  readonly parentReservationId: string | null;
  readonly effectId: string | null;
  readonly expectedOwnerRevision: string | null;
  readonly approvalPurpose: GovernedRemediationApprovalPurpose;
  readonly approvalId: string | null;
  readonly promptId: string | null;
}

export type GovernedRemediationAuthorityResult =
  | { readonly status: "authorized" }
  | {
      readonly status: "denied";
      readonly reason: "policy_denied" | "approval_missing_or_expired" | "prompt_expired";
    };

export interface GovernedRemediationAuthorityPort {
  authorize(request: GovernedRemediationAuthorityRequest): Promise<GovernedRemediationAuthorityResult>;
}

export interface GovernedRemediationParentReservationRequest {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly stateRevision: number;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly recipeSha256: string;
  readonly effectId: string;
  readonly expectedOwnerRevision: string;
  readonly preEffectApprovalId: string | null;
  readonly promptId: string | null;
  readonly operationId: string;
  readonly idempotencyKey: string;
}

export type GovernedRemediationParentReservationResult =
  | { readonly status: "reserved"; readonly reservationId: string; readonly replayed: boolean }
  | {
      readonly status: "rejected";
      readonly reason: "checkpoint_not_waiting" | "owner_revision_conflict";
    };

export interface GovernedRemediationDurableResumeRequest {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly parentReservationId: string;
  readonly recipeSha256: string;
  readonly effectId: string;
  readonly verificationReceiptId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
}

export type GovernedRemediationDurableResumeResult =
  | {
      readonly status: "resumed";
      readonly resumedRunVersion: number;
      readonly replayed: boolean;
    }
  | {
      readonly status: "rejected";
      readonly reason: "resume_failed" | "owner_revision_conflict";
    };

export interface GovernedRemediationDurableResumeObservationRequest extends GovernedRemediationDurableResumeRequest {}

export type GovernedRemediationDurableResumeObservation =
  | { readonly observation: "resume_completed"; readonly resumedRunVersion: number }
  | { readonly observation: "resume_pending" }
  | { readonly observation: "resume_not_completed" }
  | { readonly observation: "unknown" };

/** Canonical durable-run owner. UI or side-table projections cannot implement this port. */
export interface GovernedRemediationDurableParentPort {
  reserve(request: GovernedRemediationParentReservationRequest): Promise<GovernedRemediationParentReservationResult>;
  resume(request: GovernedRemediationDurableResumeRequest): Promise<GovernedRemediationDurableResumeResult>;
  observeResume(
    request: GovernedRemediationDurableResumeObservationRequest,
  ): Promise<GovernedRemediationDurableResumeObservation>;
}

export interface GovernedRemediationPromptReference {
  readonly promptId: string;
  readonly promptExpiresAt: string;
}

export interface StartGovernedRemediationInput {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceTurnId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly expectedOwnerRevision: string | null;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  readonly creationIdempotencyKey: string;
  /** Stable caller timestamp; create retries must repeat the exact command. */
  readonly requestedAt: string;
}

export type GovernedRemediationContinuationAction =
  | { readonly kind: "proceed"; readonly prompt?: GovernedRemediationPromptReference | null }
  | {
      readonly kind: "approve_pre_effect";
      readonly approvalId: string;
      readonly prompt?: GovernedRemediationPromptReference | null;
    }
  | { readonly kind: "approve_activation"; readonly approvalId: string }
  | { readonly kind: "decline" }
  | { readonly kind: "expire" };

export interface ContinueGovernedRemediationInput {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly expectedStateRevision: number;
  readonly commandIdempotencyKey: string;
  readonly action: GovernedRemediationContinuationAction;
}

export interface GovernedRemediationRecoveryFailure {
  readonly aggregateKind: "state" | "reconciliation";
  readonly aggregateId: string;
  readonly code: "recovery_failed";
}

export interface GovernedRemediationRecoveryResult {
  readonly states: readonly GovernedRemediationStoredState[];
  readonly reconciliations: readonly GovernedRemediationReconciliation[];
  readonly failures: readonly GovernedRemediationRecoveryFailure[];
}

export interface GovernedRemediationRecoveryInput {
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly pageSize?: number;
}

export interface GovernedRemediationCoordinatorOptions {
  readonly repository: GovernedRemediationRepository;
  readonly registry: GovernedRemediationRecipeRegistry;
  readonly authority: GovernedRemediationAuthorityPort;
  readonly durableParent: GovernedRemediationDurableParentPort;
  readonly deploymentProfile: DeploymentProfile;
  readonly claimantId: string;
  readonly phaseLeaseDurationSeconds?: number;
  readonly now?: () => string;
}

const TERMINAL_STATES = new Set<GovernedRemediationState>([
  "completed",
  "declined",
  "expired",
  "manual_required",
  "failed",
  "rolled_back",
  "rollback_failed",
]);

const ACTIVE_RECOVERY_STATES: readonly GovernedRemediationState[] = Object.freeze([
  "awaiting_secure_input",
  "awaiting_activation_approval",
  "applying",
  "verifying",
  "credential_verified",
  "activating",
  "verified",
  "resuming",
  "reconciling_resume",
  "rolling_back",
]);

const TERMINAL_RECONCILIATION_STATES = new Set<GovernedRemediationReconciliation["state"]>([
  "resolved_no_effect",
  "resolved_rolled_back",
  "resolved_verified",
  "resolved_resumed",
  "resolved_not_resumed",
  "manual_required",
]);

const MAX_CALLER_CLOCK_SKEW_MS = 5 * 60 * 1_000;

interface AcquiredPhaseClaim {
  readonly claim: GovernedRemediationPhaseClaim;
  readonly leaseToken: string;
}

type StatePatch = Partial<
  Pick<
    GovernedRemediationStateRecord,
    | "parentReservationId"
    | "promptId"
    | "promptExpiresAt"
    | "preEffectApprovalId"
    | "activationApprovalId"
    | "effectId"
    | "latestReceiptId"
    | "failureId"
    | "reconciliationId"
  >
>;

/**
 * Gateway authority owner for the generic governed-remediation state machine.
 * Every external effect runs under a durable lease and publishes its exact
 * receipt/failure plus state transition in one storage transaction.
 */
export class GovernedRemediationCoordinator {
  private readonly repository: GovernedRemediationRepository;
  private readonly registry: GovernedRemediationRecipeRegistry;
  private readonly authority: GovernedRemediationAuthorityPort;
  private readonly durableParent: GovernedRemediationDurableParentPort;
  private readonly deploymentProfile: DeploymentProfile;
  private readonly claimantId: string;
  private readonly phaseLeaseDurationSeconds: number;
  private readonly now: () => string;

  public constructor(options: GovernedRemediationCoordinatorOptions) {
    this.repository = options.repository;
    this.registry = options.registry;
    this.authority = options.authority;
    this.durableParent = options.durableParent;
    if (
      options.deploymentProfile !== "local_dev" &&
      options.deploymentProfile !== "trusted_local" &&
      options.deploymentProfile !== "remote_hardened"
    ) {
      throw new TypeError("Governed remediation deployment profile is unsupported.");
    }
    this.deploymentProfile = options.deploymentProfile;
    this.claimantId = secretFreeIdentifier(options.claimantId, "claimant ID");
    this.phaseLeaseDurationSeconds = boundedInteger(options.phaseLeaseDurationSeconds ?? 30, 1, 300);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Creation is side-effect free. A revision-bound continuation must opt in to every later phase. */
  public start(input: StartGovernedRemediationInput): GovernedRemediationStoredState {
    exactKeys(strictRecord(input, "creation command"), [
      "remediationId",
      "requesterActorId",
      "workspaceId",
      "sessionId",
      "sourceTurnId",
      "durableRunId",
      "blockedCheckpointId",
      "expectedWaitingRunVersion",
      "expectedOwnerRevision",
      "recipeId",
      "recipeVersion",
      "targetId",
      "requestedCapabilityId",
      "scope",
      "creationIdempotencyKey",
      "requestedAt",
    ]);
    const remediationId = secretFreeIdentifier(input.remediationId, "remediation ID");
    const requesterActorId = secretFreeIdentifier(input.requesterActorId, "requester actor ID");
    const workspaceId = secretFreeIdentifier(input.workspaceId, "workspace ID");
    const sessionId = secretFreeIdentifier(input.sessionId, "session ID");
    const sourceTurnId = secretFreeIdentifier(input.sourceTurnId, "source turn ID");
    const durableRunId = secretFreeIdentifier(input.durableRunId, "durable run ID");
    const blockedCheckpointId = secretFreeIdentifier(input.blockedCheckpointId, "blocked checkpoint ID");
    const expectedWaitingRunVersion = boundedInteger(input.expectedWaitingRunVersion, 1, Number.MAX_SAFE_INTEGER - 1);
    const expectedOwnerRevision =
      input.expectedOwnerRevision === null
        ? null
        : secretFreeIdentifier(input.expectedOwnerRevision, "expected owner revision", 512);
    const recipeId = secretFreeIdentifier(input.recipeId, "recipe ID");
    const recipeVersion = boundedInteger(input.recipeVersion, 1, Number.MAX_SAFE_INTEGER);
    const targetId = secretFreeIdentifier(input.targetId, "target ID");
    const requestedCapabilityId = secretFreeIdentifier(input.requestedCapabilityId, "requested capability ID");
    const requestedAt = timestamp(input.requestedAt, "requested timestamp");
    const coordinatorNow = timestamp(this.now(), "coordinator clock");
    if (Date.parse(requestedAt) > Date.parse(coordinatorNow) + MAX_CALLER_CLOCK_SKEW_MS) {
      throw new TypeError("Governed remediation requested timestamp is too far in the future.");
    }
    const creationIdempotencyKey = secretFreeIdentifier(input.creationIdempotencyKey, "creation idempotency key", 512);
    const normalizedScope = normalizeGovernedRemediationScope(input.scope);
    const scope = Object.freeze({
      ...normalizedScope,
      deploymentId: secretFreeIdentifier(normalizedScope.deploymentId, "scope deployment ID"),
      scopeId: secretFreeIdentifier(normalizedScope.scopeId, "scope ID"),
      targetId: secretFreeIdentifier(normalizedScope.targetId, "scope target ID"),
    });
    const resolution = this.registry.resolve({
      recipeId,
      recipeVersion,
      targetId,
      requestedCapabilityId,
      deploymentProfile: this.deploymentProfile,
      scope,
    });
    if (resolution.recipe.executionMode === "governed" && expectedOwnerRevision === null) {
      throw conflict("Governed remediation effects require an exact initial owner revision.");
    }
    if (scope.scopeKind === "workspace" && scope.scopeId !== workspaceId) {
      throw new GovernedRemediationRegistryError(
        "scope_not_allowlisted",
        "Workspace remediation scope must match the durable workspace binding.",
      );
    }
    if (scope.scopeKind === "actor" && scope.scopeId !== requesterActorId) {
      throw new GovernedRemediationRegistryError(
        "scope_not_allowlisted",
        "Actor remediation scope must match the immutable requester binding.",
      );
    }
    const record: GovernedRemediationStateRecord = {
      schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
      remediationId,
      workspaceId,
      sessionId,
      sourceTurnId,
      durableRunId,
      blockedCheckpointId,
      requesterActorId,
      recipeId: resolution.recipe.recipeId,
      recipeVersion: resolution.recipe.recipeVersion,
      recipeSha256: resolution.recipeSha256,
      scope,
      state: "blocked",
      revision: 1,
      expectedWaitingRunVersion,
      expectedOwnerRevision,
      parentReservationId: null,
      promptId: null,
      promptExpiresAt: null,
      preEffectApprovalId: null,
      activationApprovalId: null,
      effectId: null,
      latestReceiptId: null,
      failureId: null,
      reconciliationId: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };
    try {
      return this.repository.createState({
        ownerId: resolution.recipe.ownerId,
        record,
        idempotencyKey: creationIdempotencyKey,
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      let stored: GovernedRemediationStoredState;
      try {
        stored = this.repository.getState(remediationId);
      } catch (lookupError) {
        if (lookupError instanceof NotFoundError) throw error;
        throw lookupError;
      }
      assertStartReplay(stored, resolution, record);
      return stored;
    }
  }

  public async continue(input: ContinueGovernedRemediationInput): Promise<GovernedRemediationStoredState> {
    exactKeys(strictRecord(input, "continuation command"), [
      "remediationId",
      "requesterActorId",
      "workspaceId",
      "expectedStateRevision",
      "commandIdempotencyKey",
      "action",
    ]);
    const action = normalizeContinuationAction(input.action);
    const remediationId = secretFreeIdentifier(input.remediationId, "remediation ID");
    const requesterActorId = secretFreeIdentifier(input.requesterActorId, "requester actor ID");
    const workspaceId = secretFreeIdentifier(input.workspaceId, "workspace ID");
    const expectedStateRevision = boundedInteger(input.expectedStateRevision, 1, Number.MAX_SAFE_INTEGER);
    const commandIdempotencyKey = secretFreeIdentifier(
      input.commandIdempotencyKey,
      "continuation idempotency key",
      512,
    );
    let current = this.repository.getState(remediationId);
    this.assertCaller(current, requesterActorId, workspaceId);
    if (current.record.revision !== expectedStateRevision) {
      throw conflict("Governed remediation continuation has a stale state revision.");
    }
    if (TERMINAL_STATES.has(current.record.state)) return current;
    let resolution: GovernedRemediationRecipeResolution;
    try {
      resolution = this.resolveStored(current);
    } catch (error) {
      if (!(error instanceof GovernedRemediationRegistryError)) throw error;
      return this.quarantineUnboundState(current);
    }

    if (action.kind === "decline" || action.kind === "expire") {
      return this.declineOrExpire(current, resolution, action.kind, commandIdempotencyKey);
    }
    if (action.kind === "approve_activation") {
      if (current.record.state !== "awaiting_activation_approval") {
        throw conflict("Activation approval is not valid in the current remediation state.");
      }
      if (resolution.recipe.activationApproval !== "required") {
        throw conflict("This recipe does not accept a distinct activation approval.");
      }
      if (action.approvalId === current.record.preEffectApprovalId) {
        throw conflict("Activation approval must be distinct from the pre-effect approval.");
      }
      current = await this.transitionState(
        current,
        "activating",
        { activationApprovalId: action.approvalId },
        continuationKey(commandIdempotencyKey, "activate"),
        true,
      );
      return this.driveAutomatic(current.record.remediationId);
    }
    if (
      current.record.state !== "blocked" &&
      current.record.state !== "offered" &&
      current.record.state !== "awaiting_preapproval" &&
      current.record.state !== "awaiting_secure_input"
    ) {
      throw conflict("Pre-effect continuation is not valid in the current remediation state.");
    }
    if (current.record.state === "blocked") {
      current = await this.transitionState(
        current,
        "offered",
        {},
        continuationKey(commandIdempotencyKey, "offer"),
        true,
      );
    }
    if (resolution.recipe.executionMode === "manual_required") {
      return this.transitionState(
        current,
        "manual_required",
        {},
        continuationKey(commandIdempotencyKey, "manual"),
        true,
      );
    }
    return this.continuePreEffect(current, resolution, action, commandIdempotencyKey);
  }

  public async recover(input: GovernedRemediationRecoveryInput = {}): Promise<GovernedRemediationRecoveryResult> {
    const failures: GovernedRemediationRecoveryFailure[] = [];
    const states: GovernedRemediationStoredState[] = [];
    const reconciliations: GovernedRemediationReconciliation[] = [];
    const stateSeen = new Set<string>();
    const reconciliationSeen = new Set<string>();
    const limit = boundedInteger(input.limit ?? 200, 1, 1_000);
    const pageSize = Math.min(boundedInteger(input.pageSize ?? 50, 1, 200), limit);
    const updatedBefore = input.updatedBefore ?? this.now();

    let stateCursor: GovernedRemediationStateRecoveryCursor | undefined;
    while (stateSeen.size < limit) {
      const page = this.repository.listStateRecoveryCandidates({
        states: ACTIVE_RECOVERY_STATES,
        updatedBefore,
        after: stateCursor,
        limit: Math.min(pageSize, limit - stateSeen.size),
      });
      if (page.length === 0) break;
      for (const candidate of page) {
        stateCursor = {
          updatedAt: candidate.record.updatedAt,
          remediationId: candidate.record.remediationId,
        };
        if (stateSeen.has(candidate.record.remediationId)) continue;
        stateSeen.add(candidate.record.remediationId);
        try {
          states.push(await this.driveAutomatic(candidate.record.remediationId));
        } catch {
          failures.push({
            aggregateKind: "state",
            aggregateId: candidate.record.remediationId,
            code: "recovery_failed",
          });
        }
      }
      if (page.length < pageSize) break;
    }

    let reconciliationCursor: GovernedRemediationReconciliationRecoveryCursor | undefined;
    while (reconciliationSeen.size < limit) {
      const page = this.repository.listReconciliationRecoveryCandidates({
        domains: ["effect", "resume"],
        updatedBefore,
        after: reconciliationCursor,
        limit: Math.min(pageSize, limit - reconciliationSeen.size),
      });
      if (page.length === 0) break;
      for (const candidate of page) {
        reconciliationCursor = {
          updatedAt: candidate.updatedAt,
          reconciliationId: candidate.reconciliationId,
        };
        if (reconciliationSeen.has(candidate.reconciliationId)) continue;
        reconciliationSeen.add(candidate.reconciliationId);
        try {
          reconciliations.push(await this.recoverReconciliation(candidate.reconciliationId));
          if (candidate.domain === "resume") {
            states.push(await this.finalizeResumeReconciliation(candidate.remediationId));
          }
        } catch {
          failures.push({
            aggregateKind: "reconciliation",
            aggregateId: candidate.reconciliationId,
            code: "recovery_failed",
          });
        }
      }
      if (page.length < pageSize) break;
    }
    return Object.freeze({
      states: Object.freeze(states),
      reconciliations: Object.freeze(reconciliations),
      failures: Object.freeze(failures),
    });
  }

  public async recoverReconciliations(
    input: GovernedRemediationRecoveryInput = {},
  ): Promise<GovernedRemediationRecoveryResult> {
    const failures: GovernedRemediationRecoveryFailure[] = [];
    const states: GovernedRemediationStoredState[] = [];
    const reconciliations: GovernedRemediationReconciliation[] = [];
    const seen = new Set<string>();
    const limit = boundedInteger(input.limit ?? 200, 1, 1_000);
    const pageSize = Math.min(boundedInteger(input.pageSize ?? 50, 1, 200), limit);
    const updatedBefore = input.updatedBefore ?? this.now();
    let cursor: GovernedRemediationReconciliationRecoveryCursor | undefined;
    while (seen.size < limit) {
      const page = this.repository.listReconciliationRecoveryCandidates({
        domains: ["effect", "resume"],
        updatedBefore,
        after: cursor,
        limit: Math.min(pageSize, limit - seen.size),
      });
      if (page.length === 0) break;
      for (const candidate of page) {
        cursor = { updatedAt: candidate.updatedAt, reconciliationId: candidate.reconciliationId };
        if (seen.has(candidate.reconciliationId)) continue;
        seen.add(candidate.reconciliationId);
        try {
          reconciliations.push(await this.recoverReconciliation(candidate.reconciliationId));
          if (candidate.domain === "resume")
            states.push(await this.finalizeResumeReconciliation(candidate.remediationId));
        } catch {
          failures.push({
            aggregateKind: "reconciliation",
            aggregateId: candidate.reconciliationId,
            code: "recovery_failed",
          });
        }
      }
      if (page.length < pageSize) break;
    }
    return Object.freeze({
      states: Object.freeze(states),
      reconciliations: Object.freeze(reconciliations),
      failures: Object.freeze(failures),
    });
  }

  private async continuePreEffect(
    current: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    action: Extract<GovernedRemediationContinuationAction, { kind: "proceed" | "approve_pre_effect" }>,
    commandIdempotencyKey: string,
  ): Promise<GovernedRemediationStoredState> {
    const approvalRequired = requiresPreEffectApproval(resolution);
    if (action.kind === "approve_pre_effect" && !approvalRequired) {
      throw conflict("This recipe does not accept a pre-effect approval.");
    }
    if (resolution.recipe.inputKind === "none" && action.prompt) {
      throw conflict("This recipe does not accept a secure prompt reference.");
    }
    const approvalId = action.kind === "approve_pre_effect" ? action.approvalId : current.record.preEffectApprovalId;
    if (current.record.preEffectApprovalId && approvalId !== current.record.preEffectApprovalId) {
      throw conflict("Pre-effect approval continuation conflicts with the durable approval binding.");
    }
    const mayCollectInputBeforeApproval =
      resolution.recipe.preEffectApproval === "required_before_apply" && resolution.recipe.inputKind !== "none";
    if (approvalRequired && !approvalId && !mayCollectInputBeforeApproval) {
      if (current.record.state === "offered") {
        return this.transitionState(
          current,
          "awaiting_preapproval",
          {},
          continuationKey(commandIdempotencyKey, "await-preapproval"),
          true,
        );
      }
      return current;
    }
    const prompt =
      action.prompt ??
      (current.record.promptId && current.record.promptExpiresAt
        ? { promptId: current.record.promptId, promptExpiresAt: current.record.promptExpiresAt }
        : null);
    if (resolution.recipe.inputKind !== "none") {
      if (!prompt) throw conflict("This recipe requires a secure prompt reference before preflight.");
      if (
        current.record.state === "awaiting_secure_input" &&
        (current.record.promptId !== prompt.promptId || current.record.promptExpiresAt !== prompt.promptExpiresAt)
      ) {
        throw conflict("Secure prompt continuation conflicts with the durable prompt binding.");
      }
      if (Date.parse(prompt.promptExpiresAt) <= Date.parse(this.now())) {
        return this.transitionState(
          current,
          "expired",
          {},
          continuationKey(commandIdempotencyKey, "prompt-expired"),
          true,
        );
      }
      if (current.record.state !== "awaiting_secure_input") {
        current = await this.transitionState(
          current,
          "awaiting_secure_input",
          {
            promptId: prompt.promptId,
            promptExpiresAt: prompt.promptExpiresAt,
            preEffectApprovalId: approvalId,
          },
          continuationKey(commandIdempotencyKey, "bind-prompt"),
          true,
        );
      }
    }
    if (approvalRequired && !approvalId) return current;
    const reserved = await this.driveParentReservation(current, resolution, approvalId, prompt);
    return reserved.record.state === "applying" ? this.driveAutomatic(reserved.record.remediationId) : reserved;
  }

  private async driveAutomatic(remediationId: string): Promise<GovernedRemediationStoredState> {
    for (let guard = 0; guard < 32; guard += 1) {
      const current = this.repository.getState(remediationId);
      if (TERMINAL_STATES.has(current.record.state)) return current;
      let resolution: GovernedRemediationRecipeResolution;
      try {
        resolution = this.resolveStored(current);
      } catch (error) {
        if (!(error instanceof GovernedRemediationRegistryError)) throw error;
        return this.quarantineUnboundState(current);
      }
      switch (current.record.state) {
        case "awaiting_secure_input": {
          if (!current.record.promptId || !current.record.promptExpiresAt) return current;
          if (Date.parse(current.record.promptExpiresAt) <= Date.parse(this.now())) {
            return this.transitionState(current, "expired", {}, operationKey("recover-prompt-expired", remediationId));
          }
          if (requiresPreEffectApproval(resolution) && !current.record.preEffectApprovalId) return current;
          return this.driveParentReservation(current, resolution, current.record.preEffectApprovalId, {
            promptId: current.record.promptId,
            promptExpiresAt: current.record.promptExpiresAt,
          });
        }
        case "awaiting_activation_approval":
          return current;
        case "applying":
          {
            const failureCount = this.repository.listFailures(remediationId).length;
            await this.driveApplying(current, resolution);
            const after = this.repository.getState(remediationId);
            if (
              after.record.revision === current.record.revision &&
              this.repository.listFailures(remediationId).length === failureCount
            ) {
              return after;
            }
          }
          break;
        case "verifying":
          await this.driveVerifying(current, resolution);
          if (this.repository.getState(remediationId).record.revision === current.record.revision) return current;
          break;
        case "credential_verified":
          if (resolution.recipe.activationMode === "not_applicable") {
            await this.transitionState(
              current,
              "verified",
              {},
              operationKey("activation-not-applicable", remediationId),
            );
          } else if (resolution.recipe.activationApproval === "required") {
            await this.transitionState(
              current,
              "awaiting_activation_approval",
              {},
              operationKey("await-activation-approval", remediationId),
            );
            return this.repository.getState(remediationId);
          } else {
            await this.transitionState(current, "activating", {}, operationKey("activate-no-approval", remediationId));
          }
          break;
        case "activating":
          await this.driveActivating(current, resolution);
          if (this.repository.getState(remediationId).record.revision === current.record.revision) return current;
          break;
        case "verified":
          await this.transitionState(current, "resuming", {}, operationKey("begin-resume", remediationId));
          break;
        case "resuming":
          await this.driveResuming(current, resolution);
          if (this.repository.getState(remediationId).record.revision === current.record.revision) return current;
          break;
        case "reconciling_resume":
          if (!current.record.reconciliationId) return current;
          await this.recoverReconciliation(current.record.reconciliationId);
          return this.finalizeResumeReconciliation(remediationId);
        case "rolling_back":
          {
            const after = await this.driveRollback(
              current,
              resolution,
              "rolled_back",
              operationKey("automatic-rollback", remediationId),
            );
            if (after.record.revision === current.record.revision) return after;
          }
          break;
        default:
          return current;
      }
    }
    throw new Error(`Governed remediation ${remediationId} exceeded its bounded transition guard.`);
  }

  private async driveParentReservation(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    approvalId: string | null,
    prompt: GovernedRemediationPromptReference | null,
  ): Promise<GovernedRemediationStoredState> {
    if (!resolution.owner) return this.failNoEffectWithoutOwner(state, "preflight", "unowned_target");
    const effectId = remediationEffectId(state.record.remediationId);
    const operationId = operationKey(
      `parent-reserve:${state.record.revision}:${stableDigest(canonicalJsonString({ approvalId, prompt })).slice(0, 16)}`,
      state.record.remediationId,
    );
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "parent_reserve",
      operationId,
      effectId,
      expectedOwnerRevision: state.record.expectedOwnerRevision,
    });
    if (!acquired) return this.repository.getState(state.record.remediationId);

    const preflightAuthority = await this.authorize(
      state,
      resolution,
      "preflight",
      state.record.expectedOwnerRevision,
      approvalId ? "pre_effect" : null,
      approvalId,
      prompt?.promptId ?? null,
      operationId,
    );
    if (preflightAuthority.status === "denied") {
      return this.publishNoEffectFailure(
        state,
        acquired,
        "preflight",
        preflightAuthority.reason,
        null,
        "preflight-authority",
      );
    }
    let preflight;
    try {
      preflight = normalizeGovernedRemediationPreflightResult(
        await resolution.owner.preflight(
          this.ownerContext(
            state,
            resolution,
            operationId,
            effectId,
            state.record.expectedOwnerRevision,
            approvalId ? "pre_effect" : null,
            approvalId,
            prompt?.promptId ?? null,
          ),
        ),
      );
    } catch {
      return this.publishNoEffectFailure(state, acquired, "preflight", "internal_error", null, "preflight-invalid");
    }
    if (preflight.status === "rejected") {
      return this.publishNoEffectFailure(
        state,
        acquired,
        "preflight",
        preflight.reason,
        preflight.ownerRevisionObserved,
        "preflight-rejected",
      );
    }
    if (state.record.expectedOwnerRevision !== null && preflight.ownerRevision !== state.record.expectedOwnerRevision) {
      return this.publishNoEffectFailure(
        state,
        acquired,
        "preflight",
        "owner_revision_conflict",
        preflight.ownerRevision,
        "preflight-drift",
      );
    }

    // Preflight can involve a remote read. Re-evaluate the exact authority
    // immediately before reserving the durable parent effect boundary so an
    // approval or policy decision cannot expire during that observation.
    const reservationAuthority = await this.authorize(
      state,
      resolution,
      "preflight",
      preflight.ownerRevision,
      approvalId ? "pre_effect" : null,
      approvalId,
      prompt?.promptId ?? null,
      operationId,
    );
    if (reservationAuthority.status === "denied") {
      return this.publishNoEffectFailure(
        state,
        acquired,
        "preflight",
        reservationAuthority.reason,
        preflight.ownerRevision,
        "parent-reservation-authority",
      );
    }

    const reservationRequest: GovernedRemediationParentReservationRequest = Object.freeze({
      remediationId: state.record.remediationId,
      requesterActorId: state.record.requesterActorId,
      workspaceId: state.record.workspaceId,
      stateRevision: state.record.revision,
      durableRunId: state.record.durableRunId,
      blockedCheckpointId: state.record.blockedCheckpointId,
      expectedWaitingRunVersion: state.record.expectedWaitingRunVersion,
      recipeSha256: state.record.recipeSha256,
      effectId,
      expectedOwnerRevision: preflight.ownerRevision,
      preEffectApprovalId: approvalId,
      promptId: prompt?.promptId ?? null,
      operationId,
      idempotencyKey: operationKey("durable-parent-reservation", state.record.remediationId),
    });
    let reservation: GovernedRemediationParentReservationResult;
    try {
      reservation = normalizeParentReservationResult(await this.durableParent.reserve(reservationRequest));
    } catch {
      try {
        // Preserve the operation binding and immediately recover a lost
        // post-commit response without reacquiring or widening authority.
        reservation = normalizeParentReservationResult(await this.durableParent.reserve(reservationRequest));
      } catch {
        // A reservation may have committed. Leave the claim active so only an
        // exact idempotent caller retry or post-expiry takeover can continue.
        return this.repository.getState(state.record.remediationId);
      }
    }
    if (reservation.status === "rejected") {
      return this.publishNoEffectFailure(
        state,
        acquired,
        "preflight",
        reservation.reason === "owner_revision_conflict" ? "owner_revision_conflict" : "precondition_drift",
        null,
        "parent-reservation-rejected",
      );
    }
    const next = this.nextState(state, "applying", {
      parentReservationId: reservation.reservationId,
      preEffectApprovalId: approvalId,
      promptId: prompt?.promptId ?? state.record.promptId,
      promptExpiresAt: prompt?.promptExpiresAt ?? state.record.promptExpiresAt,
      effectId,
    });
    const published = this.publishClaimed(acquired, state.record.revision, {
      kind: "state_transition",
      nextState: next,
    });
    const applied = published.state ?? this.repository.getState(state.record.remediationId);
    return applied.record.state === "applying" ? this.driveAutomatic(applied.record.remediationId) : applied;
  }

  private async driveApplying(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    if (!resolution.owner || !state.record.effectId || !state.record.parentReservationId) {
      await this.quarantineEffectState(state, "apply", "internal_error", null, "apply-binding-missing");
      return;
    }
    const existing = this.findApplicationReceipt(state.record.remediationId);
    if (existing) {
      if (!this.applicationMatchesState(existing, state, resolution)) {
        await this.quarantineEffectState(state, "recovery", "owner_revision_conflict", null, "application-lineage");
        return;
      }
      const operationId = operationKey("apply-receipt-recovery", state.record.remediationId);
      const acquired = this.acquirePhaseClaim({
        state,
        aggregateKind: "state",
        aggregateId: state.record.remediationId,
        phase: "apply",
        operationId,
        effectId: state.record.effectId,
        expectedOwnerRevision: state.record.expectedOwnerRevision,
      });
      if (!acquired) return;
      this.publishClaimed(acquired, state.record.revision, {
        kind: "state_receipt",
        receipt: existing,
        nextState: this.nextState(state, "verifying", { latestReceiptId: existing.receiptId }),
      });
      return;
    }
    const priorFailures = this.repository
      .listFailures(state.record.remediationId)
      .filter((failure) => failure.phase === "apply" && failure.effectBoundary === "not_crossed");
    const attempt = priorFailures.length + 1;
    if (attempt > resolution.recipe.maxApplyAttempts) {
      const last = priorFailures.at(-1);
      if (!last) {
        await this.quarantineEffectState(state, "recovery", "internal_error", null, "attempt-lineage-missing");
        return;
      }
      const acquired = this.acquirePhaseClaim({
        state,
        aggregateKind: "state",
        aggregateId: state.record.remediationId,
        phase: "apply",
        operationId: operationKey(`apply-exhausted:${attempt}`, state.record.remediationId),
        effectId: state.record.effectId,
        expectedOwnerRevision: state.record.expectedOwnerRevision,
      });
      if (!acquired) return;
      const failure = this.failure(state, {
        phase: "recovery",
        reason: last.reason,
        effectBoundary: "not_crossed",
        disposition: "terminal_no_effect",
        ownerRevisionObserved: last.ownerRevisionObserved,
        suffix: `apply-exhausted-${attempt}`,
      });
      this.publishClaimed(acquired, state.record.revision, {
        kind: "state_failure",
        failure,
        nextState: this.nextState(state, "failed", { failureId: failure.failureId }),
      });
      return;
    }

    const operationId = operationKey(`apply:${attempt}`, state.record.remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "apply",
      operationId,
      effectId: state.record.effectId,
      expectedOwnerRevision: state.record.expectedOwnerRevision,
    });
    if (!acquired) return;
    const authority = await this.authorize(
      state,
      resolution,
      "apply",
      state.record.expectedOwnerRevision,
      state.record.preEffectApprovalId ? "pre_effect" : null,
      state.record.preEffectApprovalId,
      state.record.promptId,
      operationId,
    );
    if (authority.status === "denied") {
      this.publishNoEffectFailure(state, acquired, "apply", authority.reason, null, `apply-authority-${attempt}`);
      return;
    }
    let result;
    try {
      result = normalizeGovernedRemediationApplyResult(
        await resolution.owner.apply(
          this.ownerContext(
            state,
            resolution,
            operationId,
            state.record.effectId,
            state.record.expectedOwnerRevision,
            state.record.preEffectApprovalId ? "pre_effect" : null,
            state.record.preEffectApprovalId,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      await this.quarantineEffectState(state, "apply", "internal_error", null, `apply-invalid-${attempt}`, acquired);
      return;
    }
    if (result.status === "uncertain") {
      await this.quarantineEffectState(
        state,
        "apply",
        result.reason,
        result.ownerRevisionObserved,
        `apply-uncertain-${attempt}`,
        acquired,
      );
      return;
    }
    if (result.status === "rejected") {
      const failure = this.failure(state, {
        phase: "apply",
        reason: result.reason,
        effectBoundary: "not_crossed",
        disposition: attempt < resolution.recipe.maxApplyAttempts ? "retry_with_fresh_authority" : "terminal_no_effect",
        ownerRevisionObserved: result.ownerRevisionObserved,
        suffix: `apply-rejected-${attempt}`,
      });
      if (attempt < resolution.recipe.maxApplyAttempts) {
        this.publishClaimed(acquired, state.record.revision, { kind: "failure_only", failure });
      } else {
        this.publishClaimed(acquired, state.record.revision, {
          kind: "state_failure",
          failure,
          nextState: this.nextState(state, "failed", { failureId: failure.failureId }),
        });
      }
      return;
    }
    if (
      result.effectId !== state.record.effectId ||
      (state.record.expectedOwnerRevision !== null && result.ownerRevisionBefore !== state.record.expectedOwnerRevision)
    ) {
      await this.quarantineEffectState(
        state,
        "apply",
        "owner_revision_conflict",
        result.ownerRevisionAfter,
        `apply-lineage-${attempt}`,
        acquired,
      );
      return;
    }
    const receipt = this.applicationReceipt(state, resolution, result);
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_receipt",
      receipt,
      nextState: this.nextState(state, "verifying", { latestReceiptId: receipt.receiptId }),
    });
  }

  private async driveVerifying(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    const application = this.findApplicationReceipt(state.record.remediationId);
    if (!resolution.owner || !application || !resolution.recipe.verificationProbeId) {
      await this.quarantineEffectState(state, "recovery", "internal_error", null, "verify-lineage-missing");
      return;
    }
    if (!this.applicationMatchesState(application, state, resolution)) {
      await this.quarantineEffectState(state, "recovery", "owner_revision_conflict", null, "verify-lineage-conflict");
      return;
    }
    const expectedRevision = application.ownerRevisionAfter;
    const operationId = operationKey("verify:initial", state.record.remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "verify",
      operationId,
      effectId: application.effectId,
      expectedOwnerRevision: expectedRevision,
    });
    if (!acquired) return;
    const authority = await this.authorize(
      state,
      resolution,
      "probe",
      expectedRevision,
      state.record.preEffectApprovalId ? "pre_effect" : null,
      state.record.preEffectApprovalId,
      state.record.promptId,
      operationId,
    );
    if (authority.status === "denied") {
      this.publishRollbackRequired(state, acquired, "verify", authority.reason, expectedRevision, "verify-authority");
      return;
    }
    let result;
    try {
      result = normalizeGovernedRemediationProbeResult(
        await resolution.owner.probe(
          this.ownerContext(
            state,
            resolution,
            operationId,
            application.effectId,
            expectedRevision,
            state.record.preEffectApprovalId ? "pre_effect" : null,
            state.record.preEffectApprovalId,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      await this.quarantineEffectState(state, "recovery", "internal_error", null, "verify-invalid", acquired);
      return;
    }
    if (result.status === "rejected") {
      if (result.ownerRevisionObserved !== expectedRevision) {
        await this.quarantineEffectState(
          state,
          "recovery",
          result.reason,
          result.ownerRevisionObserved,
          "verify-drift",
          acquired,
        );
      } else {
        this.publishRollbackRequired(
          state,
          acquired,
          "verify",
          result.reason,
          result.ownerRevisionObserved,
          "verify-rejected",
        );
      }
      return;
    }
    if (result.probeId !== resolution.recipe.verificationProbeId || result.ownerRevisionObserved !== expectedRevision) {
      await this.quarantineEffectState(
        state,
        "recovery",
        "verification_failed",
        result.ownerRevisionObserved,
        "verify-binding",
        acquired,
      );
      return;
    }
    const receipt = this.verificationReceipt(state, application, null, result, "initial");
    const nextState = resolution.recipe.activationMode === "owner_step" ? "credential_verified" : "verified";
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_receipt",
      receipt,
      nextState: this.nextState(state, nextState, { latestReceiptId: receipt.receiptId }),
    });
  }

  private async driveActivating(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    const application = this.findApplicationReceipt(state.record.remediationId);
    const initialVerification = this.findVerificationReceipt(state.record.remediationId, "initial");
    if (
      !resolution.owner ||
      resolution.recipe.activationMode !== "owner_step" ||
      !application ||
      !initialVerification
    ) {
      await this.quarantineEffectState(state, "recovery", "internal_error", null, "activation-lineage-missing");
      return;
    }
    if (initialVerification.applicationReceiptId !== application.receiptId) {
      await this.quarantineEffectState(state, "recovery", "owner_revision_conflict", null, "activation-lineage");
      return;
    }
    const expectedRevision = initialVerification.ownerRevisionObserved;
    const operationId = operationKey("activate-and-verify", state.record.remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "activate_and_verify",
      operationId,
      effectId: application.effectId,
      expectedOwnerRevision: expectedRevision,
    });
    if (!acquired) return;
    const activationAuthority = await this.authorize(
      state,
      resolution,
      "activate",
      expectedRevision,
      state.record.activationApprovalId ? "activation" : null,
      state.record.activationApprovalId,
      state.record.promptId,
      operationId,
    );
    if (activationAuthority.status === "denied") {
      this.publishRollbackRequired(
        state,
        acquired,
        "activation",
        activationAuthority.reason,
        expectedRevision,
        "activation-authority",
      );
      return;
    }
    let activation;
    try {
      activation = normalizeGovernedRemediationActivationResult(
        await resolution.owner.activate(
          this.ownerContext(
            state,
            resolution,
            operationId,
            application.effectId,
            expectedRevision,
            state.record.activationApprovalId ? "activation" : null,
            state.record.activationApprovalId,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      await this.quarantineEffectState(state, "activation", "internal_error", null, "activation-invalid", acquired);
      return;
    }
    if (activation.status !== "activated") {
      if (activation.status === "rejected" && activation.ownerRevisionObserved === expectedRevision) {
        this.publishRollbackRequired(
          state,
          acquired,
          "activation",
          activation.reason,
          expectedRevision,
          "activation-rejected",
        );
      } else {
        await this.quarantineEffectState(
          state,
          "activation",
          activation.reason,
          activation.ownerRevisionObserved,
          "activation-uncertain",
          acquired,
        );
      }
      return;
    }
    if (activation.ownerRevisionBefore !== expectedRevision) {
      await this.quarantineEffectState(
        state,
        "activation",
        "owner_revision_conflict",
        activation.ownerRevisionAfter,
        "activation-binding",
        acquired,
      );
      return;
    }
    const activationReceipt = this.activationReceipt(
      state,
      application,
      initialVerification,
      activation.ownerRevisionBefore,
      activation.ownerRevisionAfter,
    );
    const probeAuthority = await this.authorize(
      state,
      resolution,
      "probe",
      activation.ownerRevisionAfter,
      state.record.activationApprovalId ? "activation" : null,
      state.record.activationApprovalId,
      state.record.promptId,
      `${operationId}:probe`,
    );
    if (probeAuthority.status === "denied") {
      this.publishActivationRollbackRequired(
        state,
        acquired,
        activationReceipt,
        probeAuthority.reason,
        activation.ownerRevisionAfter,
        "activation-probe-authority",
      );
      return;
    }
    let probe;
    try {
      probe = normalizeGovernedRemediationProbeResult(
        await resolution.owner.probe(
          this.ownerContext(
            state,
            resolution,
            `${operationId}:probe`,
            application.effectId,
            activation.ownerRevisionAfter,
            state.record.activationApprovalId ? "activation" : null,
            state.record.activationApprovalId,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      this.publishActivationQuarantine(
        state,
        acquired,
        activationReceipt,
        "internal_error",
        activation.ownerRevisionAfter,
        "activation-probe-invalid",
      );
      return;
    }
    if (
      probe.status === "rejected" ||
      probe.probeId !== resolution.recipe.verificationProbeId ||
      probe.ownerRevisionObserved !== activation.ownerRevisionAfter
    ) {
      const observed = probe.ownerRevisionObserved;
      if (observed !== activation.ownerRevisionAfter) {
        this.publishActivationQuarantine(
          state,
          acquired,
          activationReceipt,
          probe.status === "rejected" ? probe.reason : "verification_failed",
          observed,
          "activation-probe-drift",
        );
      } else {
        this.publishActivationRollbackRequired(
          state,
          acquired,
          activationReceipt,
          probe.status === "rejected" ? probe.reason : "verification_failed",
          observed,
          "activation-probe-rejected",
        );
      }
      return;
    }
    const receipt = this.verificationReceipt(state, application, activationReceipt.receiptId, probe, "activated");
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_activation_receipts",
      activationReceipt,
      verificationReceipt: receipt,
      nextState: this.nextState(state, "verified", { latestReceiptId: receipt.receiptId }),
    });
  }

  private async driveRollback(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    terminalState: "rolled_back" | "declined" | "expired",
    commandIdempotencyKey: string,
  ): Promise<GovernedRemediationStoredState> {
    const application = this.findApplicationReceipt(state.record.remediationId);
    if (!resolution.owner || !application || resolution.recipe.rollbackStrategy === "manual_required") {
      return this.publishRollbackFailureWithoutOwner(state, "internal_error", null, terminalState);
    }
    const expectedRevision = this.latestProvenOwnerRevision(state, application);
    if (!expectedRevision) {
      return this.publishRollbackFailureWithoutOwner(state, "owner_revision_conflict", null, terminalState);
    }
    const operationId = operationKey(
      `rollback:${terminalState}:${stableDigest(commandIdempotencyKey).slice(0, 32)}`,
      state.record.remediationId,
    );
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "rollback",
      operationId,
      effectId: application.effectId,
      expectedOwnerRevision: expectedRevision,
    });
    if (!acquired) return this.repository.getState(state.record.remediationId);
    const authority = await this.authorize(
      state,
      resolution,
      "rollback",
      expectedRevision,
      null,
      null,
      state.record.promptId,
      operationId,
    );
    if (authority.status === "denied") {
      return this.publishRollbackFailure(
        state,
        acquired,
        authority.reason,
        expectedRevision,
        "rollback-authority",
        terminalState,
      );
    }
    let result;
    try {
      result = normalizeGovernedRemediationRollbackResult(
        await resolution.owner.rollback(
          this.ownerContext(
            state,
            resolution,
            operationId,
            application.effectId,
            expectedRevision,
            null,
            null,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      return this.publishRollbackFailure(state, acquired, "rollback_failed", null, "rollback-invalid", terminalState);
    }
    if (result.status === "failed" || result.ownerRevisionBefore !== expectedRevision) {
      return this.publishRollbackFailure(
        state,
        acquired,
        result.status === "failed" ? "rollback_failed" : "owner_revision_conflict",
        result.status === "failed" ? result.ownerRevisionObserved : result.ownerRevisionBefore,
        "rollback-failed",
        terminalState,
      );
    }
    const receipt: Extract<GovernedRemediationReceipt, { kind: "rollback" }> = {
      ...this.receiptBase(state, stableId("rollback", state.record.remediationId, operationId)),
      kind: "rollback",
      applicationReceiptId: application.receiptId,
      rollbackStrategy: resolution.recipe.rollbackStrategy,
      outcome: "rolled_back",
      ownerRevisionBefore: result.ownerRevisionBefore,
      ownerRevisionAfter: result.ownerRevisionAfter,
    };
    const published = this.publishClaimed(acquired, state.record.revision, {
      kind: "state_receipt",
      receipt,
      nextState: this.nextState(state, terminalState, { latestReceiptId: receipt.receiptId }),
    });
    return published.state ?? this.repository.getState(state.record.remediationId);
  }

  private async driveResuming(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    const verification = this.findLatestVerificationReceipt(state.record.remediationId);
    if (!verification || !state.record.parentReservationId || !state.record.effectId) {
      await this.quarantineResume(state, "resume_failed", "resume-lineage-missing");
      return;
    }
    const operationId = operationKey("durable-resume", state.record.remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "resume",
      operationId,
      effectId: state.record.effectId,
      expectedOwnerRevision: verification.ownerRevisionObserved,
    });
    if (!acquired) return;
    const authority = await this.authorize(
      state,
      resolution,
      "resume",
      verification.ownerRevisionObserved,
      null,
      null,
      null,
      operationId,
    );
    if (authority.status === "denied") {
      const failure = this.failure(state, {
        phase: "resume",
        reason: authority.reason,
        effectBoundary: "crossed",
        disposition: "manual_required",
        ownerRevisionObserved: verification.ownerRevisionObserved,
        suffix: "resume-authority",
      });
      this.publishClaimed(acquired, state.record.revision, {
        kind: "state_failure",
        failure,
        nextState: this.nextState(state, "failed", { failureId: failure.failureId }),
      });
      return;
    }
    const request = this.resumeRequest(state, verification, operationId);
    let result: GovernedRemediationDurableResumeResult;
    try {
      result = normalizeResumeResult(await this.durableParent.resume(request));
    } catch {
      await this.quarantineResume(state, "resume_failed", "resume-uncertain", acquired);
      return;
    }
    if (result.status === "rejected") {
      const failure = this.failure(state, {
        phase: "resume",
        reason: result.reason,
        effectBoundary: "crossed",
        disposition: "manual_required",
        ownerRevisionObserved: verification.ownerRevisionObserved,
        suffix: "resume-rejected",
      });
      this.publishClaimed(acquired, state.record.revision, {
        kind: "state_failure",
        failure,
        nextState: this.nextState(state, "failed", { failureId: failure.failureId }),
      });
      return;
    }
    if (result.resumedRunVersion !== state.record.expectedWaitingRunVersion + 1) {
      await this.quarantineResume(state, "owner_revision_conflict", "resume-version", acquired);
      return;
    }
    const receipt = this.resumeReceipt(state, verification, result.resumedRunVersion);
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_receipt",
      receipt,
      nextState: this.nextState(state, "completed", { latestReceiptId: receipt.receiptId }),
    });
  }

  private async recoverReconciliation(reconciliationId: string): Promise<GovernedRemediationReconciliation> {
    const reconciliation = this.repository.getReconciliation(reconciliationId);
    if (TERMINAL_RECONCILIATION_STATES.has(reconciliation.state)) return reconciliation;
    return reconciliation.domain === "resume"
      ? this.recoverResumeReconciliation(reconciliation)
      : this.recoverEffectReconciliation(reconciliation);
  }

  private async recoverEffectReconciliation(
    reconciliation: GovernedRemediationReconciliation,
  ): Promise<GovernedRemediationReconciliation> {
    const state = this.repository.getState(reconciliation.remediationId);
    let resolution: GovernedRemediationRecipeResolution;
    try {
      resolution = this.resolveStored(state);
    } catch {
      return this.manualReconciliation(reconciliation, "unknown");
    }
    if (!resolution.owner || !state.record.effectId) return this.manualReconciliation(reconciliation, "unknown");
    const application = this.findApplicationReceipt(state.record.remediationId);
    const durableActivation = application
      ? this.findLatestActivationReceipt(state.record.remediationId, application.receiptId)
      : undefined;
    const expectedRevision =
      durableActivation?.ownerRevisionAfter ?? application?.ownerRevisionAfter ?? state.record.expectedOwnerRevision;
    const operationId = operationKey(`effect-reconcile:${reconciliation.revision}`, reconciliation.reconciliationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "reconciliation",
      aggregateId: reconciliation.reconciliationId,
      aggregateRevision: reconciliation.revision,
      phase: "effect_reconcile",
      operationId,
      effectId: state.record.effectId,
      expectedOwnerRevision: expectedRevision,
    });
    if (!acquired) return this.repository.getReconciliation(reconciliation.reconciliationId);
    const authority = await this.authorize(
      state,
      resolution,
      "effect_reconcile",
      expectedRevision,
      null,
      null,
      state.record.promptId,
      operationId,
      {
        kind: "reconciliation",
        id: reconciliation.reconciliationId,
        revision: reconciliation.revision,
      },
    );
    if (authority.status === "denied") {
      return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
    }
    let observation;
    try {
      observation = normalizeGovernedRemediationReconcileResult(
        await resolution.owner.reconcile(
          this.ownerContext(
            state,
            resolution,
            operationId,
            state.record.effectId,
            expectedRevision,
            null,
            null,
            state.record.promptId,
          ),
        ),
      );
    } catch {
      observation = { observation: "unknown" as const, ownerRevisionObserved: null };
    }
    if (observation.observation === "unknown" || observation.observation === "effect_present_unverified") {
      if (reconciliation.state === "quarantined") return reconciliation;
      return this.publishReconciliationTransition(
        reconciliation,
        acquired,
        "quarantined",
        observation.observation,
        observation.ownerRevisionObserved,
      );
    }
    if (observation.observation === "effect_absent") {
      const receipt = this.reconciliationReceipt(
        state,
        reconciliation,
        "confirmed_no_effect",
        null,
        null,
        observation.ownerRevisionObserved,
      );
      return this.publishReconciliationReceipt(
        reconciliation,
        acquired,
        receipt,
        "resolved_no_effect",
        "effect_absent",
        observation.ownerRevisionObserved,
      );
    }
    const observedApplication = observation.application;
    if (
      observedApplication.effectId !== state.record.effectId ||
      (!application &&
        state.record.expectedOwnerRevision !== null &&
        observedApplication.ownerRevisionBefore !== state.record.expectedOwnerRevision) ||
      (application &&
        (observedApplication.ownerRevisionBefore !== application.ownerRevisionBefore ||
          observedApplication.ownerRevisionAfter !== application.ownerRevisionAfter))
    ) {
      return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
    }
    if (
      observation.observation === "effect_verified" &&
      observation.ownerRevisionObserved !==
        (durableActivation?.ownerRevisionAfter ?? observedApplication.ownerRevisionAfter)
    ) {
      return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
    }
    if (
      observation.observation === "rolled_back" &&
      observation.ownerRevisionBefore !==
        (durableActivation?.ownerRevisionAfter ?? observedApplication.ownerRevisionAfter)
    ) {
      return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
    }
    const applicationReceipt =
      application ??
      this.applicationReceipt(state, resolution, observedApplication, `reconciled:${reconciliation.reconciliationId}`);
    const resolutionKind: GovernedRemediationReconciliationResolution =
      observation.observation === "rolled_back" ? "confirmed_rolled_back" : "confirmed_verified";
    const nextState = observation.observation === "rolled_back" ? "resolved_rolled_back" : "resolved_verified";
    const ownerRevisionObserved =
      observation.observation === "rolled_back" ? observation.ownerRevisionAfter : observation.ownerRevisionObserved;
    const reconciliationReceipt = this.reconciliationReceipt(
      state,
      reconciliation,
      resolutionKind,
      applicationReceipt.receiptId,
      null,
      ownerRevisionObserved,
    );
    const next = this.nextReconciliation(reconciliation, nextState, {
      observation: observation.observation,
      ownerRevisionObserved,
      resolutionReceiptId: reconciliationReceipt.receiptId,
    });
    const outcome: GovernedRemediationClaimedPhaseOutcome = application
      ? { kind: "reconciliation_receipt", receipt: reconciliationReceipt, nextReconciliation: next }
      : {
          kind: "reconciliation_application_receipts",
          applicationReceipt,
          reconciliationReceipt,
          nextReconciliation: next,
        };
    const published = this.publishClaimed(acquired, reconciliation.revision, outcome);
    return published.reconciliation ?? this.repository.getReconciliation(reconciliation.reconciliationId);
  }

  private async recoverResumeReconciliation(
    reconciliation: GovernedRemediationReconciliation,
  ): Promise<GovernedRemediationReconciliation> {
    const state = this.repository.getState(reconciliation.remediationId);
    let resolution: GovernedRemediationRecipeResolution;
    try {
      resolution = this.resolveStored(state);
    } catch {
      return this.manualReconciliation(reconciliation, "unknown");
    }
    const verification = this.findLatestVerificationReceipt(state.record.remediationId);
    if (!verification || !state.record.parentReservationId || !state.record.effectId) {
      return this.manualReconciliation(reconciliation, "unknown");
    }
    const operationId = operationKey("durable-resume", state.record.remediationId);
    const claimOperationId = operationKey(
      `resume-reconcile:${reconciliation.revision}`,
      reconciliation.reconciliationId,
    );
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "reconciliation",
      aggregateId: reconciliation.reconciliationId,
      aggregateRevision: reconciliation.revision,
      phase: "resume_reconcile",
      operationId: claimOperationId,
      effectId: state.record.effectId,
      expectedOwnerRevision: verification.ownerRevisionObserved,
    });
    if (!acquired) return this.repository.getReconciliation(reconciliation.reconciliationId);
    const authority = await this.authorize(
      state,
      resolution,
      "resume_reconcile",
      verification.ownerRevisionObserved,
      null,
      null,
      null,
      claimOperationId,
      {
        kind: "reconciliation",
        id: reconciliation.reconciliationId,
        revision: reconciliation.revision,
      },
    );
    if (authority.status === "denied") {
      return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
    }
    const request = this.resumeRequest(state, verification, operationId);
    let observation: GovernedRemediationDurableResumeObservation;
    try {
      observation = normalizeResumeObservation(await this.durableParent.observeResume(request));
    } catch {
      observation = { observation: "unknown" };
    }
    if (observation.observation === "resume_pending") {
      try {
        const replay = normalizeResumeResult(await this.durableParent.resume(request));
        observation =
          replay.status === "resumed"
            ? { observation: "resume_completed", resumedRunVersion: replay.resumedRunVersion }
            : { observation: "resume_not_completed" };
      } catch {
        observation = { observation: "unknown" };
      }
    }
    if (observation.observation === "unknown") {
      if (reconciliation.state === "quarantined") return reconciliation;
      return this.publishReconciliationTransition(reconciliation, acquired, "quarantined", "unknown", null);
    }
    if (observation.observation === "resume_completed") {
      if (observation.resumedRunVersion !== state.record.expectedWaitingRunVersion + 1) {
        return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", "unknown", null);
      }
      const resumeReceipt = this.resumeReceipt(state, verification, observation.resumedRunVersion);
      const reconciliationReceipt = this.reconciliationReceipt(
        state,
        reconciliation,
        "confirmed_resumed",
        null,
        resumeReceipt.receiptId,
        null,
      );
      const next = this.nextReconciliation(reconciliation, "resolved_resumed", {
        observation: "resume_completed",
        ownerRevisionObserved: null,
        resolutionReceiptId: reconciliationReceipt.receiptId,
      });
      const published = this.publishClaimed(acquired, reconciliation.revision, {
        kind: "reconciliation_resume_receipts",
        resumeReceipt,
        reconciliationReceipt,
        nextReconciliation: next,
      });
      return published.reconciliation ?? this.repository.getReconciliation(reconciliation.reconciliationId);
    }
    const reconciliationReceipt = this.reconciliationReceipt(
      state,
      reconciliation,
      "confirmed_not_resumed",
      null,
      null,
      null,
    );
    return this.publishReconciliationReceipt(
      reconciliation,
      acquired,
      reconciliationReceipt,
      "resolved_not_resumed",
      "resume_not_completed",
      null,
    );
  }

  private async finalizeResumeReconciliation(remediationId: string): Promise<GovernedRemediationStoredState> {
    const state = this.repository.getState(remediationId);
    if (state.record.state !== "reconciling_resume" || !state.record.reconciliationId) return state;
    const reconciliation = this.repository.getReconciliation(state.record.reconciliationId);
    if (
      reconciliation.state !== "resolved_resumed" &&
      reconciliation.state !== "resolved_not_resumed" &&
      reconciliation.state !== "manual_required"
    ) {
      return state;
    }
    const operationId = operationKey(`resume-reconciliation-finalize:${reconciliation.revision}`, remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: remediationId,
      phase: "resume_reconcile",
      operationId,
      effectId: state.record.effectId,
      expectedOwnerRevision: this.findLatestVerificationReceipt(remediationId)?.ownerRevisionObserved ?? null,
    });
    if (!acquired) return this.repository.getState(remediationId);
    if (reconciliation.state === "resolved_resumed") {
      const receipts = this.repository.listReceipts(remediationId);
      const resolutionReceipt = receipts.find(
        (candidate): candidate is Extract<GovernedRemediationReceipt, { kind: "reconciliation" }> =>
          candidate.kind === "reconciliation" && candidate.receiptId === reconciliation.resolutionReceiptId,
      );
      const receipt = resolutionReceipt?.resumeReceiptId
        ? receipts.find(
            (candidate): candidate is Extract<GovernedRemediationReceipt, { kind: "resume" }> =>
              candidate.kind === "resume" && candidate.receiptId === resolutionReceipt.resumeReceiptId,
          )
        : undefined;
      if (
        !resolutionReceipt ||
        resolutionReceipt.reconciliationId !== reconciliation.reconciliationId ||
        resolutionReceipt.failureId !== reconciliation.failureId ||
        resolutionReceipt.resolution !== "confirmed_resumed" ||
        resolutionReceipt.applicationReceiptId !== null ||
        !receipt
      ) {
        const published = this.publishClaimed(acquired, state.record.revision, {
          kind: "state_transition",
          nextState: this.nextState(state, "failed", {}),
        });
        return published.state ?? this.repository.getState(remediationId);
      }
      const published = this.publishClaimed(acquired, state.record.revision, {
        kind: "state_receipt",
        receipt,
        nextState: this.nextState(state, "completed", { latestReceiptId: receipt.receiptId }),
      });
      return published.state ?? this.repository.getState(remediationId);
    }
    const published = this.publishClaimed(acquired, state.record.revision, {
      kind: "state_transition",
      nextState: this.nextState(state, "failed", {}),
    });
    return published.state ?? this.repository.getState(remediationId);
  }

  private async declineOrExpire(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    terminalState: "decline" | "expire",
    commandIdempotencyKey: string,
  ): Promise<GovernedRemediationStoredState> {
    const target = terminalState === "decline" ? "declined" : "expired";
    if (
      state.record.state === "blocked" ||
      state.record.state === "offered" ||
      state.record.state === "awaiting_preapproval" ||
      state.record.state === "awaiting_secure_input"
    ) {
      if (state.record.state === "blocked") {
        state = await this.transitionState(state, "offered", {}, continuationKey(commandIdempotencyKey, "offer"), true);
      }
      return this.transitionState(state, target, {}, continuationKey(commandIdempotencyKey, target), true);
    }
    if (state.record.state === "awaiting_activation_approval" || state.record.state === "credential_verified") {
      return this.driveRollback(state, resolution, target, commandIdempotencyKey);
    }
    throw conflict(`Governed remediation cannot be ${terminalState}d in its current state.`);
  }

  private acquirePhaseClaim(input: {
    state: GovernedRemediationStoredState;
    aggregateKind: "state" | "reconciliation";
    aggregateId: string;
    aggregateRevision?: number;
    phase: GovernedRemediationPhase;
    operationId: string;
    effectId: string | null;
    expectedOwnerRevision: string | null;
  }): AcquiredPhaseClaim | null {
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseTokenSha256 = createHash("sha256").update(Buffer.from(leaseToken, "base64url")).digest("hex");
    // Claim identity is the stable phase generation; claimant and raw-bearer
    // rotation are acquisition witnesses so an expired worker can be replaced.
    const claimId = stableId("claim", input.aggregateId, `${input.phase}:${input.operationId}`);
    const request = {
      claimId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      remediationId: input.state.record.remediationId,
      phase: input.phase,
      claimantId: this.claimantId,
      expectedAggregateRevision: input.aggregateRevision ?? input.state.record.revision,
      operationId: input.operationId,
      effectId: input.effectId,
      expectedOwnerRevision: input.expectedOwnerRevision,
      leaseTokenSha256,
      leaseDurationSeconds: this.phaseLeaseDurationSeconds,
      acquisitionIdempotencyKey: operationKey(
        `claim-acquire:${this.claimantId}:${leaseTokenSha256.slice(0, 16)}`,
        claimId,
      ),
    } as const;
    let result: GovernedRemediationPhaseClaimAcquireResult;
    try {
      result = this.repository.acquirePhaseClaim(request);
    } catch {
      // Preserve the raw bearer in memory and replay the exact acquisition once.
      result = this.repository.acquirePhaseClaim(request);
    }
    if (result.disposition !== "acquired" && result.disposition !== "replayed") return null;
    if (
      result.claim.claimId !== claimId ||
      result.claim.claimantId !== this.claimantId ||
      !safeDigestEqual(result.claim.leaseTokenSha256, leaseTokenSha256)
    ) {
      throw conflict("Governed remediation phase-claim replay did not match its lease witness.");
    }
    return Object.freeze({ claim: result.claim, leaseToken });
  }

  private publishClaimed(
    acquired: AcquiredPhaseClaim,
    expectedAggregateRevision: number,
    outcome: GovernedRemediationClaimedPhaseOutcome,
  ): GovernedRemediationClaimedPhasePublicationResult {
    const input = {
      claim: {
        remediationId: acquired.claim.remediationId,
        phase: acquired.claim.phase,
        claimId: acquired.claim.claimId,
        claimRevision: acquired.claim.claimRevision,
        claimantId: this.claimantId,
        leaseToken: acquired.leaseToken,
      },
      expectedAggregateRevision,
      outcome,
      publicationIdempotencyKey: operationKey("claim-publish", acquired.claim.claimId),
    } as const;
    try {
      return this.repository.publishClaimedPhaseOutcome(input);
    } catch {
      // A commit may have succeeded before the response was lost. Replaying the
      // same witnessed publication is safe and must never redo the owner effect.
      return this.repository.publishClaimedPhaseOutcome(input);
    }
  }

  private async authorize(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    phase: GovernedRemediationAuthorityPhase,
    expectedOwnerRevision: string | null,
    approvalPurpose: GovernedRemediationApprovalPurpose,
    approvalId: string | null,
    promptId: string | null,
    operationId: string,
    aggregate: { kind: "reconciliation"; id: string; revision: number } | null = null,
  ): Promise<GovernedRemediationAuthorityResult> {
    if ((approvalPurpose === null) !== (approvalId === null)) return { status: "denied", reason: "policy_denied" };
    try {
      return normalizeAuthorityResult(
        await this.authority.authorize(
          Object.freeze({
            remediationId: state.record.remediationId,
            requesterActorId: state.record.requesterActorId,
            workspaceId: state.record.workspaceId,
            sessionId: state.record.sessionId,
            sourceTurnId: state.record.sourceTurnId,
            durableRunId: state.record.durableRunId,
            blockedCheckpointId: state.record.blockedCheckpointId,
            expectedWaitingRunVersion: state.record.expectedWaitingRunVersion,
            stateRevision: state.record.revision,
            phaseAggregateKind: aggregate?.kind ?? "state",
            phaseAggregateId: aggregate?.id ?? state.record.remediationId,
            phaseAggregateRevision: aggregate?.revision ?? state.record.revision,
            operationId,
            phase,
            recipeId: resolution.recipe.recipeId,
            recipeVersion: resolution.recipe.recipeVersion,
            recipeSha256: state.record.recipeSha256,
            ownerId: resolution.recipe.ownerId,
            requestedCapabilityId: resolution.recipe.requestedCapabilityId,
            deploymentProfile: this.deploymentProfile,
            scope: state.record.scope,
            parentReservationId: state.record.parentReservationId,
            effectId: state.record.effectId,
            expectedOwnerRevision,
            approvalPurpose,
            approvalId,
            promptId,
          }),
        ),
      );
    } catch {
      return { status: "denied", reason: "policy_denied" };
    }
  }

  private ownerContext(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    operationId: string,
    effectId: string,
    expectedOwnerRevision: string | null,
    approvalPurpose: GovernedRemediationApprovalPurpose,
    approvalId: string | null,
    promptId: string | null,
  ): GovernedRemediationOwnerContext {
    return Object.freeze({
      remediationId: state.record.remediationId,
      requesterActorId: state.record.requesterActorId,
      workspaceId: state.record.workspaceId,
      stateRevision: state.record.revision,
      recipe: resolution.recipe,
      recipeSha256: state.record.recipeSha256,
      scope: state.record.scope,
      effectId,
      operationId,
      expectedOwnerRevision,
      parentReservationId: state.record.parentReservationId,
      approvalPurpose,
      approvalId,
      promptId,
    });
  }

  private resolveStored(state: GovernedRemediationStoredState): GovernedRemediationRecipeResolution {
    const resolution = this.registry.resolveStored({
      recipeId: state.record.recipeId,
      recipeVersion: state.record.recipeVersion,
      deploymentProfile: this.deploymentProfile,
      scope: state.record.scope,
    });
    if (resolution.recipe.ownerId !== state.ownerId || resolution.recipeSha256 !== state.record.recipeSha256) {
      throw new GovernedRemediationRegistryError(
        "invalid_owner_binding",
        "Durable remediation recipe or owner binding does not match the callable registry.",
      );
    }
    return resolution;
  }

  private assertCaller(state: GovernedRemediationStoredState, requesterActorId: string, workspaceId: string): void {
    if (state.record.requesterActorId !== requesterActorId || state.record.workspaceId !== workspaceId) {
      throw new NotFoundError({ entity: "Governed remediation", id: state.record.remediationId });
    }
  }

  private async transitionState(
    current: GovernedRemediationStoredState,
    state: GovernedRemediationState,
    patch: StatePatch,
    idempotencyKey: string,
    strict = false,
  ): Promise<GovernedRemediationStoredState> {
    const next = this.nextState(current, state, patch);
    try {
      return this.repository.transitionState({
        ownerId: current.ownerId,
        expectedRevision: current.record.revision,
        next,
        idempotencyKey,
        recordedAt: next.updatedAt,
      }).record;
    } catch (error) {
      if (!(error instanceof ConflictError) || strict) throw error;
      const latest = this.repository.getState(current.record.remediationId);
      if (latest.record.revision > current.record.revision) return latest;
      throw error;
    }
  }

  private nextState(
    current: GovernedRemediationStoredState,
    state: GovernedRemediationState,
    patch: StatePatch,
  ): GovernedRemediationStateRecord {
    return {
      ...current.record,
      ...patch,
      state,
      revision: current.record.revision + 1,
      updatedAt: logicalTime(current.record.updatedAt),
    };
  }

  private nextReconciliation(
    current: GovernedRemediationReconciliation,
    state: GovernedRemediationReconciliation["state"],
    patch: Pick<GovernedRemediationReconciliation, "observation" | "ownerRevisionObserved" | "resolutionReceiptId">,
  ): GovernedRemediationReconciliation {
    return {
      ...current,
      ...patch,
      state,
      revision: current.revision + 1,
      updatedAt: logicalTime(current.updatedAt),
    };
  }

  private receiptBase(state: GovernedRemediationStoredState, receiptId: string) {
    return {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId,
      remediationId: state.record.remediationId,
      recipeId: state.record.recipeId,
      recipeVersion: state.record.recipeVersion,
      scope: state.record.scope,
      recordedAt: logicalTime(state.record.updatedAt),
    } as const;
  }

  private applicationReceipt(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    result: { effectId: string; ownerRevisionBefore: string | null; ownerRevisionAfter: string },
    discriminator = result.effectId,
  ): GovernedRemediationApplicationReceipt {
    return {
      ...this.receiptBase(state, stableId("application", state.record.remediationId, discriminator)),
      kind: "application",
      ownerId: resolution.recipe.ownerId,
      effectId: result.effectId,
      ownerRevisionBefore: result.ownerRevisionBefore,
      ownerRevisionAfter: result.ownerRevisionAfter,
    };
  }

  private verificationReceipt(
    state: GovernedRemediationStoredState,
    application: GovernedRemediationApplicationReceipt,
    activationReceiptId: string | null,
    result: { probeId: string; ownerRevisionObserved: string },
    discriminator: "initial" | "activated",
  ): GovernedRemediationVerificationReceipt {
    return {
      ...this.receiptBase(state, stableId("verification", state.record.remediationId, discriminator)),
      kind: "verification",
      applicationReceiptId: application.receiptId,
      activationReceiptId,
      probeId: result.probeId,
      probeResult: "accepted",
      ownerRevisionObserved: result.ownerRevisionObserved,
    };
  }

  private activationReceipt(
    state: GovernedRemediationStoredState,
    application: GovernedRemediationApplicationReceipt,
    initialVerification: GovernedRemediationVerificationReceipt,
    ownerRevisionBefore: string,
    ownerRevisionAfter: string,
  ): GovernedRemediationActivationReceipt {
    return {
      ...this.receiptBase(state, stableId("activation", state.record.remediationId, initialVerification.receiptId)),
      kind: "activation",
      applicationReceiptId: application.receiptId,
      initialVerificationReceiptId: initialVerification.receiptId,
      ownerRevisionBefore,
      ownerRevisionAfter,
    };
  }

  private resumeReceipt(
    state: GovernedRemediationStoredState,
    verification: GovernedRemediationVerificationReceipt,
    resumedRunVersion: number,
  ): Extract<GovernedRemediationReceipt, { kind: "resume" }> {
    return {
      ...this.receiptBase(state, stableId("resume", state.record.remediationId, verification.receiptId)),
      kind: "resume",
      verificationReceiptId: verification.receiptId,
      durableRunId: state.record.durableRunId,
      blockedCheckpointId: state.record.blockedCheckpointId,
      resumedRunVersion,
    };
  }

  private reconciliationReceipt(
    state: GovernedRemediationStoredState,
    reconciliation: GovernedRemediationReconciliation,
    resolution: GovernedRemediationReconciliationResolution,
    applicationReceiptId: string | null,
    resumeReceiptId: string | null,
    ownerRevisionObserved: string | null,
  ): Extract<GovernedRemediationReceipt, { kind: "reconciliation" }> {
    return {
      ...this.receiptBase(
        state,
        stableId("reconciliation", state.record.remediationId, `${reconciliation.reconciliationId}:${resolution}`),
      ),
      recordedAt: logicalTime(reconciliation.updatedAt),
      kind: "reconciliation",
      reconciliationId: reconciliation.reconciliationId,
      failureId: reconciliation.failureId,
      resolution,
      applicationReceiptId,
      resumeReceiptId,
      ownerRevisionObserved,
    };
  }

  private failure(
    state: GovernedRemediationStoredState,
    input: Omit<
      GovernedRemediationFailure,
      "schemaVersion" | "failureId" | "remediationId" | "recipeId" | "recipeVersion" | "scope" | "occurredAt"
    > & { suffix: string },
  ): GovernedRemediationFailure {
    return {
      schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
      failureId: stableId("failure", state.record.remediationId, `${input.phase}:${input.suffix}`),
      remediationId: state.record.remediationId,
      recipeId: state.record.recipeId,
      recipeVersion: state.record.recipeVersion,
      scope: state.record.scope,
      phase: input.phase,
      reason: input.reason,
      effectBoundary: input.effectBoundary,
      disposition: input.disposition,
      ownerRevisionObserved: input.ownerRevisionObserved,
      occurredAt: logicalTime(state.record.updatedAt),
    };
  }

  private reconciliation(
    state: GovernedRemediationStoredState,
    failure: GovernedRemediationFailure,
    domain: GovernedRemediationReconciliationDomain,
    reason: GovernedRemediationReconciliation["reason"],
    ownerRevisionObserved: string | null,
  ): GovernedRemediationReconciliation {
    const createdAt = logicalTime(failure.occurredAt);
    return {
      schemaVersion: GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
      reconciliationId: stableId("reconciliation", state.record.remediationId, failure.failureId),
      remediationId: state.record.remediationId,
      failureId: failure.failureId,
      recipeId: state.record.recipeId,
      recipeVersion: state.record.recipeVersion,
      scope: state.record.scope,
      domain,
      reason,
      observation: "unknown",
      state: "quarantined",
      ownerRevisionObserved,
      resolutionReceiptId: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private publishNoEffectFailure(
    state: GovernedRemediationStoredState,
    acquired: AcquiredPhaseClaim,
    phase: GovernedRemediationFailurePhase,
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
    suffix: string,
  ): GovernedRemediationStoredState {
    const failure = this.failure(state, {
      phase,
      reason,
      effectBoundary: "not_crossed",
      disposition: "terminal_no_effect",
      ownerRevisionObserved,
      suffix,
    });
    const published = this.publishClaimed(acquired, state.record.revision, {
      kind: "state_failure",
      failure,
      nextState: this.nextState(state, "failed", { failureId: failure.failureId }),
    });
    return published.state ?? this.repository.getState(state.record.remediationId);
  }

  private publishRollbackRequired(
    state: GovernedRemediationStoredState,
    acquired: AcquiredPhaseClaim,
    phase: "verify" | "activation",
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string,
    suffix: string,
  ): void {
    const failure = this.failure(state, {
      phase,
      reason,
      effectBoundary: "crossed",
      disposition: "rollback_required",
      ownerRevisionObserved,
      suffix,
    });
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_failure",
      failure,
      nextState: this.nextState(state, "rolling_back", { failureId: failure.failureId }),
    });
  }

  private publishActivationRollbackRequired(
    state: GovernedRemediationStoredState,
    acquired: AcquiredPhaseClaim,
    activationReceipt: GovernedRemediationActivationReceipt,
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string,
    suffix: string,
  ): void {
    const failure = this.failure(state, {
      phase: "activation",
      reason,
      effectBoundary: "crossed",
      disposition: "rollback_required",
      ownerRevisionObserved,
      suffix,
    });
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_activation_failure",
      activationReceipt,
      failure,
      nextState: this.nextState(state, "rolling_back", {
        latestReceiptId: activationReceipt.receiptId,
        failureId: failure.failureId,
      }),
    });
  }

  private publishActivationQuarantine(
    state: GovernedRemediationStoredState,
    acquired: AcquiredPhaseClaim,
    activationReceipt: GovernedRemediationActivationReceipt,
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
    suffix: string,
  ): void {
    const failure = this.failure(state, {
      phase: "activation",
      reason,
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved,
      suffix,
    });
    const reconciliation = this.reconciliation(
      state,
      failure,
      "effect",
      ownerRevisionObserved === activationReceipt.ownerRevisionAfter ? "effect_state_unknown" : "owner_revision_drift",
      ownerRevisionObserved,
    );
    this.publishClaimed(acquired, state.record.revision, {
      kind: "state_activation_failure_reconciliation",
      activationReceipt,
      failure,
      reconciliation,
      nextState: this.nextState(state, "failed", {
        latestReceiptId: activationReceipt.receiptId,
        failureId: failure.failureId,
        reconciliationId: reconciliation.reconciliationId,
      }),
    });
  }

  private async quarantineEffectState(
    state: GovernedRemediationStoredState,
    phase: "apply" | "activation" | "recovery",
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
    suffix: string,
    acquired?: AcquiredPhaseClaim,
  ): Promise<GovernedRemediationStoredState> {
    const recoveryPhase: GovernedRemediationPhase =
      phase === "apply"
        ? "apply"
        : phase === "activation"
          ? "activate_and_verify"
          : effectRecoveryClaimPhase(state.record.state);
    const application = this.findApplicationReceipt(state.record.remediationId);
    const expectedRecoveryRevision =
      ownerRevisionObserved ??
      (application ? this.latestProvenOwnerRevision(state, application) : state.record.expectedOwnerRevision);
    const claim =
      acquired ??
      this.acquirePhaseClaim({
        state,
        aggregateKind: "state",
        aggregateId: state.record.remediationId,
        phase: recoveryPhase,
        operationId: operationKey(`quarantine:${suffix}`, state.record.remediationId),
        effectId: state.record.effectId,
        expectedOwnerRevision: expectedRecoveryRevision,
      });
    if (!claim) return this.repository.getState(state.record.remediationId);
    const failure = this.failure(state, {
      phase,
      reason,
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved,
      suffix,
    });
    const reconciliation = this.reconciliation(
      state,
      failure,
      "effect",
      suffix.includes("lineage") || suffix.includes("drift") ? "owner_revision_drift" : "effect_state_unknown",
      ownerRevisionObserved,
    );
    const nextState = state.record.state === "rolling_back" ? "rollback_failed" : "failed";
    const published = this.publishClaimed(claim, state.record.revision, {
      kind: "state_failure_reconciliation",
      failure,
      reconciliation,
      nextState: this.nextState(state, nextState, {
        failureId: failure.failureId,
        reconciliationId: reconciliation.reconciliationId,
      }),
    });
    return published.state ?? this.repository.getState(state.record.remediationId);
  }

  private async quarantineResume(
    state: GovernedRemediationStoredState,
    reason: GovernedRemediationFailureReason,
    suffix: string,
    acquired?: AcquiredPhaseClaim,
  ): Promise<GovernedRemediationStoredState> {
    const claim =
      acquired ??
      this.acquirePhaseClaim({
        state,
        aggregateKind: "state",
        aggregateId: state.record.remediationId,
        phase: "resume",
        operationId: operationKey(`resume-quarantine:${suffix}`, state.record.remediationId),
        effectId: state.record.effectId,
        expectedOwnerRevision:
          this.findLatestVerificationReceipt(state.record.remediationId)?.ownerRevisionObserved ?? null,
      });
    if (!claim) return this.repository.getState(state.record.remediationId);
    const failure = this.failure(state, {
      phase: "resume",
      reason,
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved: null,
      suffix,
    });
    const reconciliation = this.reconciliation(state, failure, "resume", "resume_receipt_missing", null);
    const published = this.publishClaimed(claim, state.record.revision, {
      kind: "state_failure_reconciliation",
      failure,
      reconciliation,
      nextState: this.nextState(state, "reconciling_resume", {
        failureId: failure.failureId,
        reconciliationId: reconciliation.reconciliationId,
      }),
    });
    return published.state ?? this.repository.getState(state.record.remediationId);
  }

  private publishRollbackFailure(
    state: GovernedRemediationStoredState,
    acquired: AcquiredPhaseClaim,
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
    suffix: string,
    terminalIntent: "rolled_back" | "declined" | "expired",
  ): GovernedRemediationStoredState {
    const failure = this.failure(state, {
      phase: "rollback",
      reason,
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved,
      suffix: `${suffix}:${terminalIntent}`,
    });
    const reconciliation = this.reconciliation(state, failure, "effect", "rollback_failed", ownerRevisionObserved);
    const nextState = state.record.state === "rolling_back" ? "rollback_failed" : "failed";
    const published = this.publishClaimed(acquired, state.record.revision, {
      kind: "state_failure_reconciliation",
      failure,
      reconciliation,
      nextState: this.nextState(state, nextState, {
        failureId: failure.failureId,
        reconciliationId: reconciliation.reconciliationId,
      }),
    });
    return published.state ?? this.repository.getState(state.record.remediationId);
  }

  private async publishRollbackFailureWithoutOwner(
    state: GovernedRemediationStoredState,
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
    terminalIntent: "rolled_back" | "declined" | "expired",
  ): Promise<GovernedRemediationStoredState> {
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "rollback",
      operationId: operationKey(`rollback-unavailable:${terminalIntent}`, state.record.remediationId),
      effectId: state.record.effectId,
      expectedOwnerRevision: ownerRevisionObserved,
    });
    if (!acquired) return this.repository.getState(state.record.remediationId);
    return this.publishRollbackFailure(
      state,
      acquired,
      reason,
      ownerRevisionObserved,
      "rollback-unavailable",
      terminalIntent,
    );
  }

  private failNoEffectWithoutOwner(
    state: GovernedRemediationStoredState,
    phase: GovernedRemediationFailurePhase,
    reason: GovernedRemediationFailureReason,
  ): GovernedRemediationStoredState {
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "state",
      aggregateId: state.record.remediationId,
      phase: "parent_reserve",
      operationId: operationKey("owner-unavailable", state.record.remediationId),
      effectId: remediationEffectId(state.record.remediationId),
      expectedOwnerRevision: state.record.expectedOwnerRevision,
    });
    if (!acquired) return this.repository.getState(state.record.remediationId);
    return this.publishNoEffectFailure(state, acquired, phase, reason, null, "owner-unavailable");
  }

  private async quarantineUnboundState(state: GovernedRemediationStoredState): Promise<GovernedRemediationStoredState> {
    if (state.record.effectId === null) {
      return this.failNoEffectWithoutOwner(state, "recovery", "unowned_target");
    }
    if (state.record.state === "resuming") {
      return this.quarantineResume(state, "unowned_target", "recipe-binding-drift");
    }
    if (state.record.state === "reconciling_resume") {
      if (!state.record.reconciliationId) return state;
      this.manualReconciliation(this.repository.getReconciliation(state.record.reconciliationId), "unknown");
      return this.finalizeResumeReconciliation(state.record.remediationId);
    }
    return this.quarantineEffectState(state, "recovery", "unowned_target", null, "recipe-binding-drift");
  }

  private publishReconciliationTransition(
    reconciliation: GovernedRemediationReconciliation,
    acquired: AcquiredPhaseClaim,
    state: GovernedRemediationReconciliation["state"],
    observation: GovernedRemediationReconciliationObservation,
    ownerRevisionObserved: string | null,
  ): GovernedRemediationReconciliation {
    const published = this.publishClaimed(acquired, reconciliation.revision, {
      kind: "reconciliation_transition",
      nextReconciliation: this.nextReconciliation(reconciliation, state, {
        observation,
        ownerRevisionObserved,
        resolutionReceiptId: null,
      }),
    });
    return published.reconciliation ?? this.repository.getReconciliation(reconciliation.reconciliationId);
  }

  private publishReconciliationReceipt(
    reconciliation: GovernedRemediationReconciliation,
    acquired: AcquiredPhaseClaim,
    receipt: Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>,
    state: GovernedRemediationReconciliation["state"],
    observation: GovernedRemediationReconciliationObservation,
    ownerRevisionObserved: string | null,
  ): GovernedRemediationReconciliation {
    const published = this.publishClaimed(acquired, reconciliation.revision, {
      kind: "reconciliation_receipt",
      receipt,
      nextReconciliation: this.nextReconciliation(reconciliation, state, {
        observation,
        ownerRevisionObserved,
        resolutionReceiptId: receipt.receiptId,
      }),
    });
    return published.reconciliation ?? this.repository.getReconciliation(reconciliation.reconciliationId);
  }

  private manualReconciliation(
    reconciliation: GovernedRemediationReconciliation,
    observation: GovernedRemediationReconciliationObservation,
  ): GovernedRemediationReconciliation {
    if (reconciliation.state === "manual_required") return reconciliation;
    const state = this.repository.getState(reconciliation.remediationId);
    const acquired = this.acquirePhaseClaim({
      state,
      aggregateKind: "reconciliation",
      aggregateId: reconciliation.reconciliationId,
      aggregateRevision: reconciliation.revision,
      phase: reconciliation.domain === "resume" ? "resume_reconcile" : "effect_reconcile",
      operationId: operationKey("manual-reconciliation", reconciliation.reconciliationId),
      effectId: state.record.effectId,
      expectedOwnerRevision: reconciliation.ownerRevisionObserved,
    });
    if (!acquired) return this.repository.getReconciliation(reconciliation.reconciliationId);
    return this.publishReconciliationTransition(reconciliation, acquired, "manual_required", observation, null);
  }

  private findApplicationReceipt(remediationId: string): GovernedRemediationApplicationReceipt | undefined {
    return this.repository
      .listReceipts(remediationId)
      .find((receipt): receipt is GovernedRemediationApplicationReceipt => receipt.kind === "application");
  }

  private findVerificationReceipt(
    remediationId: string,
    discriminator: "initial" | "activated",
  ): GovernedRemediationVerificationReceipt | undefined {
    const expectedId = stableId("verification", remediationId, discriminator);
    return this.repository
      .listReceipts(remediationId)
      .find(
        (receipt): receipt is GovernedRemediationVerificationReceipt =>
          receipt.kind === "verification" && receipt.receiptId === expectedId,
      );
  }

  private findLatestVerificationReceipt(remediationId: string): GovernedRemediationVerificationReceipt | undefined {
    return this.repository
      .listReceipts(remediationId)
      .filter((receipt): receipt is GovernedRemediationVerificationReceipt => receipt.kind === "verification")
      .at(-1);
  }

  private findLatestActivationReceipt(
    remediationId: string,
    applicationReceiptId: string,
  ): GovernedRemediationActivationReceipt | undefined {
    return this.repository
      .listReceipts(remediationId)
      .filter(
        (receipt): receipt is GovernedRemediationActivationReceipt =>
          receipt.kind === "activation" && receipt.applicationReceiptId === applicationReceiptId,
      )
      .at(-1);
  }

  private applicationMatchesState(
    application: GovernedRemediationApplicationReceipt,
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): boolean {
    return (
      application.remediationId === state.record.remediationId &&
      application.recipeId === state.record.recipeId &&
      application.recipeVersion === state.record.recipeVersion &&
      application.ownerId === resolution.recipe.ownerId &&
      application.effectId === state.record.effectId &&
      (state.record.expectedOwnerRevision === null ||
        application.ownerRevisionBefore === state.record.expectedOwnerRevision)
    );
  }

  private latestProvenOwnerRevision(
    state: GovernedRemediationStoredState,
    application: GovernedRemediationApplicationReceipt,
  ): string | null {
    return (
      this.findLatestActivationReceipt(state.record.remediationId, application.receiptId)?.ownerRevisionAfter ??
      this.findLatestVerificationReceipt(state.record.remediationId)?.ownerRevisionObserved ??
      application.ownerRevisionAfter
    );
  }

  private resumeRequest(
    state: GovernedRemediationStoredState,
    verification: GovernedRemediationVerificationReceipt,
    operationId: string,
  ): GovernedRemediationDurableResumeRequest {
    if (!state.record.parentReservationId || !state.record.effectId) {
      throw conflict("Durable resume is missing its parent reservation or effect binding.");
    }
    return Object.freeze({
      remediationId: state.record.remediationId,
      requesterActorId: state.record.requesterActorId,
      workspaceId: state.record.workspaceId,
      durableRunId: state.record.durableRunId,
      blockedCheckpointId: state.record.blockedCheckpointId,
      expectedWaitingRunVersion: state.record.expectedWaitingRunVersion,
      parentReservationId: state.record.parentReservationId,
      recipeSha256: state.record.recipeSha256,
      effectId: state.record.effectId,
      verificationReceiptId: verification.receiptId,
      operationId,
      idempotencyKey: operationKey("durable-resume", state.record.remediationId),
    });
  }
}

function requiresPreEffectApproval(resolution: GovernedRemediationRecipeResolution): boolean {
  return (
    resolution.recipe.preEffectApproval === "required_before_input" ||
    resolution.recipe.preEffectApproval === "required_before_apply"
  );
}

function effectRecoveryClaimPhase(state: GovernedRemediationState): GovernedRemediationPhase {
  if (state === "applying") return "apply";
  if (state === "verifying") return "verify";
  if (state === "activating") return "activate_and_verify";
  return "rollback";
}

function normalizeContinuationAction(input: unknown): GovernedRemediationContinuationAction {
  const record = strictRecord(input, "continuation action");
  if (record.kind === "proceed") {
    exactKeys(record, ["kind", ...(Object.prototype.hasOwnProperty.call(record, "prompt") ? ["prompt"] : [])]);
    return Object.freeze({ kind: "proceed", prompt: record.prompt == null ? null : normalizePrompt(record.prompt) });
  }
  if (record.kind === "approve_pre_effect") {
    exactKeys(record, [
      "kind",
      "approvalId",
      ...(Object.prototype.hasOwnProperty.call(record, "prompt") ? ["prompt"] : []),
    ]);
    return Object.freeze({
      kind: "approve_pre_effect",
      approvalId: secretFreeIdentifier(record.approvalId, "pre-effect approval ID"),
      prompt: record.prompt == null ? null : normalizePrompt(record.prompt),
    });
  }
  if (record.kind === "approve_activation") {
    exactKeys(record, ["kind", "approvalId"]);
    return Object.freeze({
      kind: "approve_activation",
      approvalId: secretFreeIdentifier(record.approvalId, "activation approval ID"),
    });
  }
  if (record.kind === "decline" || record.kind === "expire") {
    exactKeys(record, ["kind"]);
    return Object.freeze({ kind: record.kind });
  }
  throw new TypeError("Governed remediation continuation action is unsupported.");
}

function normalizePrompt(input: unknown): GovernedRemediationPromptReference {
  const record = strictRecord(input, "prompt reference");
  exactKeys(record, ["promptId", "promptExpiresAt"]);
  const promptExpiresAt = timestamp(record.promptExpiresAt, "prompt expiry");
  return Object.freeze({
    promptId: secretFreeIdentifier(record.promptId, "prompt ID"),
    promptExpiresAt,
  });
}

function normalizeAuthorityResult(input: unknown): GovernedRemediationAuthorityResult {
  const record = strictRecord(input, "authority result");
  if (record.status === "authorized") {
    exactKeys(record, ["status"]);
    return { status: "authorized" };
  }
  if (record.status === "denied") {
    exactKeys(record, ["status", "reason"]);
    if (
      record.reason !== "policy_denied" &&
      record.reason !== "approval_missing_or_expired" &&
      record.reason !== "prompt_expired"
    ) {
      throw new TypeError("Governed remediation authority denial reason is unsupported.");
    }
    return { status: "denied", reason: record.reason };
  }
  throw new TypeError("Governed remediation authority result is unsupported.");
}

function normalizeParentReservationResult(input: unknown): GovernedRemediationParentReservationResult {
  const record = strictRecord(input, "parent reservation result");
  if (record.status === "reserved") {
    exactKeys(record, ["status", "reservationId", "replayed"]);
    if (typeof record.replayed !== "boolean") throw new TypeError("Parent reservation replay flag must be boolean.");
    return {
      status: "reserved",
      reservationId: secretFreeIdentifier(record.reservationId, "parent reservation ID"),
      replayed: record.replayed,
    };
  }
  if (record.status === "rejected") {
    exactKeys(record, ["status", "reason"]);
    if (record.reason !== "checkpoint_not_waiting" && record.reason !== "owner_revision_conflict") {
      throw new TypeError("Parent reservation rejection reason is unsupported.");
    }
    return { status: "rejected", reason: record.reason };
  }
  throw new TypeError("Parent reservation result is unsupported.");
}

function normalizeResumeResult(input: unknown): GovernedRemediationDurableResumeResult {
  const record = strictRecord(input, "durable resume result");
  if (record.status === "resumed") {
    exactKeys(record, ["status", "resumedRunVersion", "replayed"]);
    if (typeof record.replayed !== "boolean") throw new TypeError("Durable resume replay flag must be boolean.");
    return {
      status: "resumed",
      resumedRunVersion: boundedInteger(record.resumedRunVersion, 1, Number.MAX_SAFE_INTEGER),
      replayed: record.replayed,
    };
  }
  if (record.status === "rejected") {
    exactKeys(record, ["status", "reason"]);
    if (record.reason !== "resume_failed" && record.reason !== "owner_revision_conflict") {
      throw new TypeError("Durable resume rejection reason is unsupported.");
    }
    return { status: "rejected", reason: record.reason };
  }
  throw new TypeError("Durable resume result is unsupported.");
}

function normalizeResumeObservation(input: unknown): GovernedRemediationDurableResumeObservation {
  const record = strictRecord(input, "durable resume observation");
  if (record.observation === "resume_completed") {
    exactKeys(record, ["observation", "resumedRunVersion"]);
    return {
      observation: "resume_completed",
      resumedRunVersion: boundedInteger(record.resumedRunVersion, 1, Number.MAX_SAFE_INTEGER),
    };
  }
  if (
    record.observation === "resume_pending" ||
    record.observation === "resume_not_completed" ||
    record.observation === "unknown"
  ) {
    exactKeys(record, ["observation"]);
    return { observation: record.observation };
  }
  throw new TypeError("Durable resume observation is unsupported.");
}

function assertStartReplay(
  stored: GovernedRemediationStoredState,
  resolution: GovernedRemediationRecipeResolution,
  attempted: GovernedRemediationStateRecord,
): void {
  const storedBindings = {
    ownerId: stored.ownerId,
    requesterActorId: stored.record.requesterActorId,
    remediationId: stored.record.remediationId,
    workspaceId: stored.record.workspaceId,
    sessionId: stored.record.sessionId,
    sourceTurnId: stored.record.sourceTurnId,
    durableRunId: stored.record.durableRunId,
    blockedCheckpointId: stored.record.blockedCheckpointId,
    recipeId: stored.record.recipeId,
    recipeVersion: stored.record.recipeVersion,
    recipeSha256: stored.record.recipeSha256,
    scope: stored.record.scope,
    expectedWaitingRunVersion: stored.record.expectedWaitingRunVersion,
    expectedOwnerRevision: stored.record.expectedOwnerRevision,
    createdAt: stored.record.createdAt,
  };
  const attemptedBindings = {
    ownerId: resolution.recipe.ownerId,
    requesterActorId: attempted.requesterActorId,
    remediationId: attempted.remediationId,
    workspaceId: attempted.workspaceId,
    sessionId: attempted.sessionId,
    sourceTurnId: attempted.sourceTurnId,
    durableRunId: attempted.durableRunId,
    blockedCheckpointId: attempted.blockedCheckpointId,
    recipeId: attempted.recipeId,
    recipeVersion: attempted.recipeVersion,
    recipeSha256: attempted.recipeSha256,
    scope: attempted.scope,
    expectedWaitingRunVersion: attempted.expectedWaitingRunVersion,
    expectedOwnerRevision: attempted.expectedOwnerRevision,
    createdAt: attempted.createdAt,
  };
  if (canonicalJsonString(storedBindings) !== canonicalJsonString(attemptedBindings)) {
    throw conflict("Governed remediation creation replay conflicts with durable authority.");
  }
}

function strictRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`Governed remediation ${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Governed remediation ${label} must be a plain data object.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new TypeError(`Governed remediation ${label} must contain only plain data fields.`);
    }
  }
  return input as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.getOwnPropertySymbols(record).length > 0 ||
    canonicalJsonString(Object.getOwnPropertyNames(record).sort()) !== canonicalJsonString([...expected].sort())
  ) {
    throw new TypeError("Governed remediation runtime envelope has an invalid key set.");
  }
}

function secretFreeIdentifier(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /(?:(?:api[_-]?key|auth(?:orization)?|cookie|credential|password|secret|token)\s*[:=]\s*["']?[a-z0-9._\/-]{8,}|\bbearer\s+[a-z0-9._~+\/-]{12,}|\bsk-[a-z0-9_-]{16,}|\bghp_[a-z0-9_]{16,}|\bxox[baprs]-[a-z0-9-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Governed remediation ${label} is not a canonical secret-free identifier.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Governed remediation ${label} must be an ISO timestamp.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Governed remediation integer is out of bounds.");
  }
  return value;
}

function remediationEffectId(remediationId: string): string {
  return stableId("effect", remediationId, "apply");
}

function continuationKey(commandIdempotencyKey: string, step: string): string {
  return `gr:command:${stableDigest(commandIdempotencyKey)}:${step}`;
}

function operationKey(operation: string, aggregateId: string): string {
  return `gr:${operation}:${stableDigest(aggregateId).slice(0, 32)}`;
}

function stableId(kind: string, aggregateId: string, discriminator: string): string {
  return `gr_${kind}_${stableDigest(`${aggregateId}\u0000${discriminator}`).slice(0, 40)}`;
}

function stableDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function logicalTime(value: string): string {
  return new Date(Date.parse(value) + 1).toISOString();
}

function conflict(message: string): ConflictError {
  return new ConflictError({ message });
}
