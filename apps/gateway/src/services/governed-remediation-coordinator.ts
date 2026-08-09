import { createHash } from "node:crypto";
import {
  ConflictError,
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  NotFoundError,
  canonicalJsonString,
  type DeploymentProfile,
  type GovernedRemediationApplicationReceipt,
  type GovernedRemediationFailure,
  type GovernedRemediationFailurePhase,
  type GovernedRemediationFailureReason,
  type GovernedRemediationReceipt,
  type GovernedRemediationReconciliation,
  type GovernedRemediationReconciliationObservation,
  type GovernedRemediationReconciliationResolution,
  type GovernedRemediationScope,
  type GovernedRemediationState,
  type GovernedRemediationStateRecord,
  type GovernedRemediationVerificationReceipt,
} from "@goatcitadel/contracts";
import { GovernedRemediationRepository, type GovernedRemediationStoredState } from "@goatcitadel/storage";
import {
  GovernedRemediationRecipeRegistry,
  GovernedRemediationRegistryError,
  type GovernedRemediationOwnerContext,
  type GovernedRemediationOwnerFailureReason,
  type GovernedRemediationOwnerPort,
  type GovernedRemediationRecipeResolution,
} from "./governed-remediation-registry.js";

export type GovernedRemediationAuthorityPhase =
  | "preflight"
  | "apply"
  | "probe"
  | "activate"
  | "rollback"
  | "resume"
  | "reconcile";

export interface GovernedRemediationAuthorityRequest {
  readonly remediationId: string;
  readonly phase: GovernedRemediationAuthorityPhase;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly ownerId: string;
  readonly requestedCapabilityId: string;
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
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

export interface GovernedRemediationDurableResumeRequest {
  readonly remediationId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly expectedWaitingRunVersion: number;
  readonly verificationReceiptId: string;
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

/** The durable owner, not a UI projection, fences child-to-parent resume. */
export interface GovernedRemediationDurableResumePort {
  resume(request: GovernedRemediationDurableResumeRequest): Promise<GovernedRemediationDurableResumeResult>;
}

export interface GovernedRemediationPromptReference {
  readonly promptId: string;
  readonly promptExpiresAt: string;
}

export interface StartGovernedRemediationInput {
  readonly remediationId: string;
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
  readonly approvalId?: string | null;
  readonly prompt?: GovernedRemediationPromptReference | null;
  /** Stable caller timestamp; create retries must repeat the exact command. */
  readonly requestedAt: string;
}

export interface ContinueGovernedRemediationInput {
  readonly remediationId: string;
  readonly approvalId?: string | null;
  readonly prompt?: GovernedRemediationPromptReference | null;
}

export interface GovernedRemediationRecoveryResult {
  readonly states: readonly GovernedRemediationStoredState[];
  readonly reconciliations: readonly GovernedRemediationReconciliation[];
}

export interface GovernedRemediationCoordinatorOptions {
  readonly repository: GovernedRemediationRepository;
  readonly registry: GovernedRemediationRecipeRegistry;
  readonly authority: GovernedRemediationAuthorityPort;
  readonly durableResume: GovernedRemediationDurableResumePort;
  readonly deploymentProfile: DeploymentProfile;
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

/**
 * Generic, secret-free coordinator foundation. It coordinates only recipes in
 * the immutable callable registry and leaves concrete provider/OAuth/service
 * adapters to later owner-specific tranches.
 */
export class GovernedRemediationCoordinator {
  private readonly repository: GovernedRemediationRepository;
  private readonly registry: GovernedRemediationRecipeRegistry;
  private readonly authority: GovernedRemediationAuthorityPort;
  private readonly durableResume: GovernedRemediationDurableResumePort;
  private readonly deploymentProfile: DeploymentProfile;

  public constructor(options: GovernedRemediationCoordinatorOptions) {
    this.repository = options.repository;
    this.registry = options.registry;
    this.authority = options.authority;
    this.durableResume = options.durableResume;
    this.deploymentProfile = options.deploymentProfile;
  }

  public async start(input: StartGovernedRemediationInput): Promise<GovernedRemediationStoredState> {
    const resolution = this.registry.resolve({
      recipeId: input.recipeId,
      recipeVersion: input.recipeVersion,
      targetId: input.targetId,
      requestedCapabilityId: input.requestedCapabilityId,
      deploymentProfile: this.deploymentProfile,
      scope: input.scope,
    });
    if (input.scope.scopeKind === "workspace" && input.scope.scopeId !== input.workspaceId) {
      throw new GovernedRemediationRegistryError(
        "scope_not_allowlisted",
        "Workspace remediation scope must match the durable workspace binding.",
      );
    }
    const record: GovernedRemediationStateRecord = {
      schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
      remediationId: input.remediationId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceTurnId: input.sourceTurnId,
      durableRunId: input.durableRunId,
      blockedCheckpointId: input.blockedCheckpointId,
      recipeId: resolution.recipe.recipeId,
      recipeVersion: resolution.recipe.recipeVersion,
      scope: input.scope,
      state: "blocked",
      revision: 1,
      expectedWaitingRunVersion: input.expectedWaitingRunVersion,
      expectedOwnerRevision: input.expectedOwnerRevision,
      promptId: null,
      promptExpiresAt: null,
      approvalId: null,
      effectId: null,
      latestReceiptId: null,
      failureId: null,
      reconciliationId: null,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    let current: GovernedRemediationStoredState;
    try {
      current = this.repository.getState(input.remediationId);
      assertStartReplay(current, resolution, record);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      current = this.repository.createState({
        ownerId: resolution.recipe.ownerId,
        record,
        idempotencyKey: operationKey("create", input.remediationId),
      });
    }
    if (current.record.state === "blocked") current = await this.transition(current, "offered", {}, "offer");
    return this.drive(current.record.remediationId, {
      approvalId: input.approvalId ?? null,
      prompt: input.prompt ?? null,
    });
  }

  public async continue(input: ContinueGovernedRemediationInput): Promise<GovernedRemediationStoredState> {
    return this.drive(input.remediationId, {
      approvalId: input.approvalId ?? null,
      prompt: input.prompt ?? null,
    });
  }

  public async recover(
    input: { updatedBefore?: string; limit?: number } = {},
  ): Promise<GovernedRemediationRecoveryResult> {
    const states: GovernedRemediationStoredState[] = [];
    for (const candidate of this.repository.listStateRecoveryCandidates(input)) {
      states.push(await this.drive(candidate.record.remediationId, { approvalId: null, prompt: null }));
    }
    const reconciliations = await this.recoverReconciliations(input);
    return Object.freeze({ states: Object.freeze(states), reconciliations: Object.freeze(reconciliations) });
  }

  public async recoverReconciliations(
    input: { updatedBefore?: string; limit?: number } = {},
  ): Promise<GovernedRemediationReconciliation[]> {
    const recovered: GovernedRemediationReconciliation[] = [];
    for (const candidate of this.repository.listReconciliationRecoveryCandidates(input)) {
      const stored = this.repository.getState(candidate.remediationId);
      let resolution: GovernedRemediationRecipeResolution;
      try {
        resolution = this.resolveStored(stored);
      } catch (error) {
        if (!(error instanceof GovernedRemediationRegistryError)) throw error;
        recovered.push(this.quarantineOrManual(candidate, "manual_required"));
        continue;
      }
      if (!resolution.owner) {
        recovered.push(this.quarantineOrManual(candidate, "manual_required"));
        continue;
      }
      const authority = await this.authorize(stored, resolution, "reconcile");
      if (authority.status === "denied") {
        recovered.push(this.quarantineOrManual(candidate, "quarantined"));
        continue;
      }
      const context = this.ownerContext(stored, resolution, "reconcile");
      let observation: Awaited<ReturnType<GovernedRemediationOwnerPort["reconcile"]>>;
      try {
        observation = await resolution.owner.reconcile(context);
      } catch {
        observation = { observation: "unknown", ownerRevisionObserved: null };
      }
      if (observation.observation === "unknown" || observation.observation === "effect_present_unverified") {
        recovered.push(this.quarantineOrManual(candidate, "quarantined", observation.observation));
        continue;
      }
      const ownerRevisionObserved =
        observation.observation === "effect_absent"
          ? observation.ownerRevisionObserved
          : observation.observation === "rolled_back"
            ? observation.ownerRevisionAfter
            : observation.application.ownerRevisionAfter;
      const resolutionKind = reconciliationResolution(observation.observation);
      const receipt = this.ensureReconciliationReceipt(stored, candidate, resolutionKind, ownerRevisionObserved);
      recovered.push(
        this.transitionReconciliation(candidate, reconciliationState(resolutionKind), {
          observation: observation.observation,
          ownerRevisionObserved,
          resolutionReceiptId: receipt.receiptId,
        }),
      );
    }
    return recovered;
  }

  private async drive(
    remediationId: string,
    continuation: { approvalId: string | null; prompt: GovernedRemediationPromptReference | null },
  ): Promise<GovernedRemediationStoredState> {
    let justEnteredApplying = false;
    for (let guard = 0; guard < 40; guard += 1) {
      const current = this.repository.getState(remediationId);
      if (TERMINAL_STATES.has(current.record.state)) return current;
      const resolution = this.resolveStored(current);
      if (current.record.state === "blocked") {
        await this.transition(current, "offered", {}, "offer");
        continue;
      }
      if (current.record.state === "offered") {
        if (resolution.recipe.executionMode === "manual_required") {
          await this.transition(current, "manual_required", {}, "manual");
          continue;
        }
        if (requiresPreapproval(resolution) && continuation.approvalId === null) {
          await this.transition(current, "awaiting_preapproval", {}, "wait-preapproval");
          continue;
        }
        if (resolution.recipe.inputKind !== "none") {
          if (!continuation.prompt) return current;
          await this.transition(
            current,
            "awaiting_secure_input",
            {
              approvalId: continuation.approvalId,
              promptId: continuation.prompt.promptId,
              promptExpiresAt: continuation.prompt.promptExpiresAt,
            },
            "wait-secure-input",
          );
          continue;
        }
        const preflight = await this.preflight(current, resolution, continuation.approvalId, null);
        if (!preflight) continue;
        await this.transition(
          current,
          "applying",
          {
            approvalId: continuation.approvalId,
            effectId: effectId(current.record.remediationId),
          },
          "apply",
        );
        justEnteredApplying = true;
        continue;
      }
      if (current.record.state === "awaiting_preapproval") {
        if (continuation.approvalId === null) return current;
        if (resolution.recipe.inputKind !== "none" && !continuation.prompt) return current;
        if (resolution.recipe.inputKind !== "none") {
          await this.transition(
            current,
            "awaiting_secure_input",
            {
              approvalId: continuation.approvalId,
              promptId: continuation.prompt!.promptId,
              promptExpiresAt: continuation.prompt!.promptExpiresAt,
            },
            "approved-wait-input",
          );
          continue;
        }
        const preflight = await this.preflight(current, resolution, continuation.approvalId, null);
        if (!preflight) continue;
        await this.transition(
          current,
          "applying",
          { approvalId: continuation.approvalId, effectId: effectId(current.record.remediationId) },
          "approved-apply",
        );
        justEnteredApplying = true;
        continue;
      }
      if (current.record.state === "awaiting_secure_input") {
        if (!continuation.prompt || continuation.prompt.promptId !== current.record.promptId) return current;
        const preflight = await this.preflight(
          current,
          resolution,
          current.record.approvalId,
          continuation.prompt.promptId,
        );
        if (!preflight) continue;
        await this.transition(
          current,
          "applying",
          {
            promptId: current.record.promptId,
            promptExpiresAt: current.record.promptExpiresAt,
            effectId: effectId(current.record.remediationId),
          },
          "input-apply",
        );
        justEnteredApplying = true;
        continue;
      }
      if (current.record.state === "applying") {
        await this.driveApplying(current, resolution, justEnteredApplying);
        justEnteredApplying = false;
        continue;
      }
      if (current.record.state === "verifying") {
        await this.driveVerifying(current, resolution, "initial");
        continue;
      }
      if (current.record.state === "credential_verified") {
        if (resolution.owner?.activationMode !== "owner_step") {
          await this.transition(current, "verified", {}, "activation-not-applicable");
          continue;
        }
        if (resolution.recipe.activationApproval === "required" && continuation.approvalId === null) {
          await this.transition(current, "awaiting_activation_approval", {}, "wait-activation-approval");
          continue;
        }
        await this.transition(
          current,
          "activating",
          { approvalId: continuation.approvalId ?? current.record.approvalId },
          "activate",
        );
        continue;
      }
      if (current.record.state === "awaiting_activation_approval") {
        if (continuation.approvalId === null) return current;
        await this.transition(current, "activating", { approvalId: continuation.approvalId }, "approved-activate");
        continue;
      }
      if (current.record.state === "activating") {
        await this.driveActivating(current, resolution);
        continue;
      }
      if (current.record.state === "verified") {
        await this.transition(current, "resuming", {}, "resume");
        continue;
      }
      if (current.record.state === "resuming") {
        await this.driveResuming(current, resolution);
        continue;
      }
      if (current.record.state === "rolling_back") {
        await this.driveRollingBack(current, resolution);
        continue;
      }
      return current;
    }
    throw new Error(`Governed remediation ${remediationId} exceeded its bounded coordinator transition guard.`);
  }

  private async preflight(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    approvalId: string | null,
    promptId: string | null,
  ): Promise<boolean> {
    if (!resolution.owner) return false;
    const authority = await this.authorize(state, resolution, "preflight", approvalId, promptId);
    if (authority.status === "denied") {
      await this.failWithoutEffect(state, resolution, "preflight", authority.reason, "authority");
      return false;
    }
    const context = this.ownerContext(state, resolution, "preflight", approvalId, promptId);
    let result: Awaited<ReturnType<GovernedRemediationOwnerPort["preflight"]>>;
    try {
      result = await resolution.owner.preflight(context);
    } catch {
      await this.failWithoutEffect(state, resolution, "preflight", "internal_error", "owner-throw");
      return false;
    }
    if (result.status === "rejected") {
      await this.failWithoutEffect(
        state,
        resolution,
        "preflight",
        result.reason,
        "owner-rejected",
        result.ownerRevisionObserved,
      );
      return false;
    }
    if (state.record.expectedOwnerRevision !== null && result.ownerRevision !== state.record.expectedOwnerRevision) {
      await this.failWithoutEffect(
        state,
        resolution,
        "preflight",
        "owner_revision_conflict",
        "revision-drift",
        result.ownerRevision,
      );
      return false;
    }
    return true;
  }

  private async driveApplying(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    justEntered: boolean,
  ): Promise<void> {
    if (!resolution.owner || !state.record.effectId) {
      await this.failWithoutEffect(state, resolution, "apply", "internal_error", "owner-or-effect-missing");
      return;
    }
    if (!justEntered) {
      const recovered = await this.recoverApplying(state, resolution);
      if (recovered) return;
    }
    for (let attempt = 1; attempt <= resolution.recipe.maxApplyAttempts; attempt += 1) {
      const authority = await this.authorize(state, resolution, "apply");
      if (authority.status === "denied") {
        await this.failWithoutEffect(state, resolution, "apply", authority.reason, `authority-${attempt}`);
        return;
      }
      const context = this.ownerContext(state, resolution, `apply-${attempt}`);
      let result: Awaited<ReturnType<GovernedRemediationOwnerPort["apply"]>>;
      try {
        result = await resolution.owner.apply(context);
      } catch {
        result = { status: "uncertain", reason: "internal_error", ownerRevisionObserved: null };
      }
      if (result.status === "uncertain") {
        await this.quarantineUnknownEffect(state, resolution, "apply", result.reason, result.ownerRevisionObserved);
        return;
      }
      if (result.status === "rejected") {
        const failure = this.ensureFailure(state, {
          phase: "apply",
          reason: result.reason,
          effectBoundary: "not_crossed",
          disposition:
            attempt < resolution.recipe.maxApplyAttempts ? "retry_with_fresh_authority" : "terminal_no_effect",
          ownerRevisionObserved: result.ownerRevisionObserved,
          suffix: `apply-${attempt}`,
        });
        if (attempt < resolution.recipe.maxApplyAttempts) continue;
        await this.transition(state, "failed", { failureId: failure.failureId }, `apply-failed-${attempt}`);
        return;
      }
      if (
        result.effectId !== state.record.effectId ||
        (state.record.expectedOwnerRevision !== null &&
          result.ownerRevisionBefore !== state.record.expectedOwnerRevision)
      ) {
        const application = this.ensureApplicationReceipt(state, resolution, result);
        const failure = this.ensureFailure(state, {
          phase: "apply",
          reason: "owner_revision_conflict",
          effectBoundary: "crossed",
          disposition: "rollback_required",
          ownerRevisionObserved: result.ownerRevisionAfter,
          suffix: "apply-binding-conflict",
        });
        await this.transition(
          state,
          "rolling_back",
          { latestReceiptId: application.receiptId, failureId: failure.failureId },
          "apply-binding-conflict",
        );
        return;
      }
      const application = this.ensureApplicationReceipt(state, resolution, result);
      await this.transition(state, "verifying", { latestReceiptId: application.receiptId }, "application-recorded");
      return;
    }
  }

  private async recoverApplying(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<boolean> {
    if (!resolution.owner) return false;
    const durableApplication = this.findApplicationReceipt(state.record.remediationId);
    if (durableApplication) {
      await this.transition(
        state,
        "verifying",
        { latestReceiptId: durableApplication.receiptId },
        "application-receipt-recovered",
      );
      return true;
    }
    const authority = await this.authorize(state, resolution, "reconcile");
    if (authority.status === "denied") {
      await this.quarantineUnknownEffect(state, resolution, "recovery", authority.reason, null);
      return true;
    }
    let observation: Awaited<ReturnType<GovernedRemediationOwnerPort["reconcile"]>>;
    try {
      observation = await resolution.owner.reconcile(this.ownerContext(state, resolution, "recover-apply"));
    } catch {
      observation = { observation: "unknown", ownerRevisionObserved: null };
    }
    if (observation.observation === "effect_absent") return false;
    if (observation.observation === "unknown") {
      await this.quarantineUnknownEffect(
        state,
        resolution,
        "recovery",
        "internal_error",
        observation.ownerRevisionObserved,
      );
      return true;
    }
    const application = this.ensureApplicationReceipt(state, resolution, {
      ...observation.application,
    });
    if (observation.observation === "rolled_back") {
      const rollingBack = await this.transition(
        state,
        "rolling_back",
        { latestReceiptId: application.receiptId },
        "recovered-rolled-back",
      );
      const receipt = this.ensureRollbackReceipt(rollingBack, resolution, application, observation.ownerRevisionAfter);
      await this.transition(rollingBack, "rolled_back", { latestReceiptId: receipt.receiptId }, "rollback-recovered");
      return true;
    }
    await this.transition(state, "verifying", { latestReceiptId: application.receiptId }, "application-recovered");
    return true;
  }

  private async driveVerifying(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    suffix: "initial" | "activated",
    expectedOwnerRevision?: string,
  ): Promise<void> {
    if (!resolution.owner || !resolution.recipe.verificationProbeId) {
      await this.beginRollback(state, resolution, "internal_error", null, `probe-missing-${suffix}`);
      return;
    }
    const application = this.findApplicationReceipt(state.record.remediationId);
    if (!application) {
      await this.quarantineUnknownEffect(state, resolution, "recovery", "internal_error", null);
      return;
    }
    const authority = await this.authorize(state, resolution, "probe");
    if (authority.status === "denied") {
      await this.beginRollback(state, resolution, authority.reason, null, `probe-authority-${suffix}`);
      return;
    }
    let result: Awaited<ReturnType<GovernedRemediationOwnerPort["probe"]>>;
    try {
      result = await resolution.owner.probe(this.ownerContext(state, resolution, `probe-${suffix}`));
    } catch {
      result = { status: "rejected", reason: "internal_error", ownerRevisionObserved: null };
    }
    if (
      result.status === "rejected" ||
      result.probeId !== resolution.recipe.verificationProbeId ||
      result.ownerRevisionObserved !== (expectedOwnerRevision ?? application.ownerRevisionAfter)
    ) {
      const reason = result.status === "rejected" ? result.reason : "verification_failed";
      const observed = result.status === "rejected" ? result.ownerRevisionObserved : result.ownerRevisionObserved;
      await this.beginRollback(state, resolution, reason, observed, `probe-rejected-${suffix}`);
      return;
    }
    const receipt = this.ensureVerificationReceipt(state, resolution, application, result, suffix);
    const nextState =
      suffix === "activated"
        ? "verified"
        : resolution.owner.activationMode === "owner_step"
          ? "credential_verified"
          : "verified";
    await this.transition(state, nextState, { latestReceiptId: receipt.receiptId }, `verified-${suffix}`);
  }

  private async driveActivating(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    if (!resolution.owner || resolution.owner.activationMode !== "owner_step") {
      await this.beginRollback(state, resolution, "internal_error", null, "activation-owner-missing");
      return;
    }
    const authority = await this.authorize(state, resolution, "activate");
    if (authority.status === "denied") {
      await this.beginRollback(state, resolution, authority.reason, null, "activation-authority");
      return;
    }
    let result: Awaited<ReturnType<GovernedRemediationOwnerPort["activate"]>>;
    try {
      result = await resolution.owner.activate(this.ownerContext(state, resolution, "activate"));
    } catch {
      result = { status: "uncertain", reason: "internal_error", ownerRevisionObserved: null };
    }
    if (result.status !== "activated") {
      await this.beginRollback(state, resolution, result.reason, result.ownerRevisionObserved, "activation-failed");
      return;
    }
    await this.driveVerifying(state, resolution, "activated", result.ownerRevisionAfter);
  }

  private async driveResuming(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    const verification = this.findLatestVerificationReceipt(state.record.remediationId);
    if (!verification) {
      await this.failResume(state, resolution, "resume_failed", "verification-receipt-missing");
      return;
    }
    const authority = await this.authorize(state, resolution, "resume");
    if (authority.status === "denied") {
      await this.failResume(state, resolution, authority.reason, "resume-authority");
      return;
    }
    const idempotencyKey = operationKey("durable-resume", state.record.remediationId);
    let result: GovernedRemediationDurableResumeResult;
    try {
      result = await this.durableResume.resume({
        remediationId: state.record.remediationId,
        durableRunId: state.record.durableRunId,
        blockedCheckpointId: state.record.blockedCheckpointId,
        expectedWaitingRunVersion: state.record.expectedWaitingRunVersion,
        verificationReceiptId: verification.receiptId,
        idempotencyKey,
      });
    } catch {
      result = { status: "rejected", reason: "resume_failed" };
    }
    if (result.status === "rejected" || result.resumedRunVersion !== state.record.expectedWaitingRunVersion + 1) {
      await this.failResume(
        state,
        resolution,
        result.status === "rejected" ? result.reason : "owner_revision_conflict",
        "durable-resume-rejected",
      );
      return;
    }
    const receipt = this.ensureResumeReceipt(state, verification, result.resumedRunVersion);
    await this.transition(state, "completed", { latestReceiptId: receipt.receiptId }, "resume-recorded");
  }

  private async driveRollingBack(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
  ): Promise<void> {
    const application = this.findApplicationReceipt(state.record.remediationId);
    if (!resolution.owner || !application || resolution.recipe.rollbackStrategy === "manual_required") {
      await this.failRollback(state, resolution, null, "rollback-owner-missing");
      return;
    }
    const authority = await this.authorize(state, resolution, "rollback");
    if (authority.status === "denied") {
      await this.failRollback(state, resolution, null, "rollback-authority");
      return;
    }
    let result: Awaited<ReturnType<GovernedRemediationOwnerPort["rollback"]>>;
    try {
      result = await resolution.owner.rollback(this.ownerContext(state, resolution, "rollback"));
    } catch {
      result = { status: "failed", ownerRevisionObserved: null, effectState: "unknown" };
    }
    if (result.status === "failed") {
      await this.failRollback(state, resolution, result.ownerRevisionObserved, "rollback-failed");
      return;
    }
    const receipt = this.ensureRollbackReceipt(state, resolution, application, result.ownerRevisionAfter);
    await this.transition(state, "rolled_back", { latestReceiptId: receipt.receiptId }, "rollback-recorded");
  }

  private async beginRollback(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    reason: GovernedRemediationOwnerFailureReason,
    ownerRevisionObserved: string | null,
    suffix: string,
  ): Promise<void> {
    const failure = this.ensureFailure(state, {
      phase: state.record.state === "activating" ? "activation" : "verify",
      reason,
      effectBoundary: "crossed",
      disposition: "rollback_required",
      ownerRevisionObserved,
      suffix,
    });
    await this.transition(state, "rolling_back", { failureId: failure.failureId }, suffix);
  }

  private async failWithoutEffect(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    phase: GovernedRemediationFailurePhase,
    reason: GovernedRemediationFailureReason,
    suffix: string,
    ownerRevisionObserved: string | null = null,
  ): Promise<void> {
    const failure = this.ensureFailure(state, {
      phase,
      reason,
      effectBoundary: "not_crossed",
      disposition: "terminal_no_effect",
      ownerRevisionObserved,
      suffix,
    });
    await this.transition(state, "failed", { failureId: failure.failureId }, suffix);
  }

  private async quarantineUnknownEffect(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    phase: "apply" | "recovery",
    reason: GovernedRemediationFailureReason,
    ownerRevisionObserved: string | null,
  ): Promise<void> {
    const failure = this.ensureFailure(state, {
      phase,
      reason,
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved,
      suffix: `unknown-${phase}`,
    });
    const reconciliation = this.ensureReconciliation(state, failure, "effect_state_unknown", ownerRevisionObserved);
    const nextState: GovernedRemediationState =
      state.record.state === "verifying" || state.record.state === "activating" ? "rolling_back" : "failed";
    await this.transition(
      state,
      nextState,
      { failureId: failure.failureId, reconciliationId: reconciliation.reconciliationId },
      `unknown-${phase}`,
    );
  }

  private async failRollback(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    ownerRevisionObserved: string | null,
    suffix: string,
  ): Promise<void> {
    const failure = this.ensureFailure(state, {
      phase: "rollback",
      reason: "rollback_failed",
      effectBoundary: "unknown",
      disposition: "manual_required",
      ownerRevisionObserved,
      suffix,
    });
    const reconciliation = this.ensureReconciliation(state, failure, "rollback_failed", ownerRevisionObserved);
    await this.transition(
      state,
      "rollback_failed",
      { failureId: failure.failureId, reconciliationId: reconciliation.reconciliationId },
      suffix,
    );
  }

  private async failResume(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    reason: GovernedRemediationFailureReason,
    suffix: string,
  ): Promise<void> {
    const failure = this.ensureFailure(state, {
      phase: "resume",
      reason,
      effectBoundary: "crossed",
      disposition: "manual_required",
      ownerRevisionObserved: null,
      suffix,
    });
    const reconciliation = this.ensureReconciliation(state, failure, "resume_receipt_missing", null);
    await this.transition(
      state,
      "failed",
      { failureId: failure.failureId, reconciliationId: reconciliation.reconciliationId },
      suffix,
    );
  }

  private ensureApplicationReceipt(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    result: {
      effectId: string;
      ownerRevisionBefore: string | null;
      ownerRevisionAfter: string;
    },
  ): GovernedRemediationApplicationReceipt {
    const receiptId = stableId("application", state.record.remediationId, result.effectId);
    const existing = this.findReceipt(receiptId);
    if (existing) return existing as GovernedRemediationApplicationReceipt;
    return this.repository.appendReceipt({
      receipt: {
        ...this.receiptBase(state, receiptId, "application"),
        kind: "application",
        ownerId: resolution.recipe.ownerId,
        effectId: result.effectId,
        ownerRevisionBefore: result.ownerRevisionBefore,
        ownerRevisionAfter: result.ownerRevisionAfter,
      },
      idempotencyKey: operationKey("receipt-application", state.record.remediationId),
    }) as GovernedRemediationApplicationReceipt;
  }

  private ensureVerificationReceipt(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    application: GovernedRemediationApplicationReceipt,
    result: { probeId: string; ownerRevisionObserved: string },
    suffix: string,
  ): GovernedRemediationVerificationReceipt {
    const receiptId = stableId("verification", state.record.remediationId, suffix);
    const existing = this.findReceipt(receiptId);
    if (existing) return existing as GovernedRemediationVerificationReceipt;
    return this.repository.appendReceipt({
      receipt: {
        ...this.receiptBase(state, receiptId, "verification"),
        kind: "verification",
        applicationReceiptId: application.receiptId,
        probeId: result.probeId,
        probeResult: "accepted",
        ownerRevisionObserved: result.ownerRevisionObserved,
      },
      idempotencyKey: operationKey(`receipt-verification-${suffix}`, state.record.remediationId),
    }) as GovernedRemediationVerificationReceipt;
  }

  private ensureRollbackReceipt(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    application: GovernedRemediationApplicationReceipt,
    ownerRevisionAfter: string,
  ): Extract<GovernedRemediationReceipt, { kind: "rollback" }> {
    const receiptId = stableId("rollback", state.record.remediationId, application.receiptId);
    const existing = this.findReceipt(receiptId);
    if (existing) return existing as Extract<GovernedRemediationReceipt, { kind: "rollback" }>;
    if (resolution.recipe.rollbackStrategy === "manual_required") {
      throw new Error("Manual rollback cannot produce a governed rollback receipt.");
    }
    return this.repository.appendReceipt({
      receipt: {
        ...this.receiptBase(state, receiptId, "rollback"),
        kind: "rollback",
        applicationReceiptId: application.receiptId,
        rollbackStrategy: resolution.recipe.rollbackStrategy,
        outcome: "rolled_back",
        ownerRevisionAfter,
      },
      idempotencyKey: operationKey("receipt-rollback", state.record.remediationId),
    }) as Extract<GovernedRemediationReceipt, { kind: "rollback" }>;
  }

  private ensureResumeReceipt(
    state: GovernedRemediationStoredState,
    verification: GovernedRemediationVerificationReceipt,
    resumedRunVersion: number,
  ): Extract<GovernedRemediationReceipt, { kind: "resume" }> {
    const receiptId = stableId("resume", state.record.remediationId, verification.receiptId);
    const existing = this.findReceipt(receiptId);
    if (existing) return existing as Extract<GovernedRemediationReceipt, { kind: "resume" }>;
    return this.repository.appendReceipt({
      receipt: {
        ...this.receiptBase(state, receiptId, "resume"),
        kind: "resume",
        verificationReceiptId: verification.receiptId,
        durableRunId: state.record.durableRunId,
        blockedCheckpointId: state.record.blockedCheckpointId,
        resumedRunVersion,
      },
      idempotencyKey: operationKey("receipt-resume", state.record.remediationId),
    }) as Extract<GovernedRemediationReceipt, { kind: "resume" }>;
  }

  private ensureReconciliationReceipt(
    state: GovernedRemediationStoredState,
    reconciliation: GovernedRemediationReconciliation,
    resolution: GovernedRemediationReconciliationResolution,
    ownerRevisionObserved: string | null,
  ): Extract<GovernedRemediationReceipt, { kind: "reconciliation" }> {
    const receiptId = stableId("reconciliation", state.record.remediationId, reconciliation.reconciliationId);
    const existing = this.findReceipt(receiptId);
    if (existing) return existing as Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>;
    return this.repository.appendReceipt({
      receipt: {
        ...this.receiptBase(state, receiptId, "reconciliation"),
        kind: "reconciliation",
        reconciliationId: reconciliation.reconciliationId,
        failureId: reconciliation.failureId,
        resolution,
        ownerRevisionObserved,
      },
      idempotencyKey: operationKey("receipt-reconciliation", reconciliation.reconciliationId),
    }) as Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>;
  }

  private ensureFailure(
    state: GovernedRemediationStoredState,
    input: Omit<
      GovernedRemediationFailure,
      "schemaVersion" | "failureId" | "remediationId" | "recipeId" | "recipeVersion" | "scope" | "occurredAt"
    > & {
      suffix: string;
    },
  ): GovernedRemediationFailure {
    const failureId = stableId("failure", state.record.remediationId, `${input.phase}:${input.suffix}`);
    const existing = this.findFailure(failureId);
    if (existing) return existing;
    const failure: GovernedRemediationFailure = {
      schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
      failureId,
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
    return this.repository.appendFailure({
      failure,
      idempotencyKey: operationKey(`failure-${input.phase}-${input.suffix}`, state.record.remediationId),
    });
  }

  private ensureReconciliation(
    state: GovernedRemediationStoredState,
    failure: GovernedRemediationFailure,
    reason: GovernedRemediationReconciliation["reason"],
    ownerRevisionObserved: string | null,
  ): GovernedRemediationReconciliation {
    const reconciliationId = stableId("reconciliation", state.record.remediationId, failure.failureId);
    const existing = this.findReconciliation(reconciliationId);
    if (existing) return existing;
    const createdAt = logicalTime(failure.occurredAt);
    return this.repository.createReconciliation({
      reconciliation: {
        schemaVersion: GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
        reconciliationId,
        remediationId: state.record.remediationId,
        failureId: failure.failureId,
        recipeId: state.record.recipeId,
        recipeVersion: state.record.recipeVersion,
        scope: state.record.scope,
        reason,
        observation: "unknown",
        state: "quarantined",
        ownerRevisionObserved,
        resolutionReceiptId: null,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
      idempotencyKey: operationKey("reconciliation-create", failure.failureId),
    });
  }

  private receiptBase(
    state: GovernedRemediationStoredState,
    receiptId: string,
    _kind: GovernedRemediationReceipt["kind"],
  ) {
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

  private findApplicationReceipt(remediationId: string): GovernedRemediationApplicationReceipt | undefined {
    return this.repository
      .listReceipts(remediationId)
      .find((receipt): receipt is GovernedRemediationApplicationReceipt => receipt.kind === "application");
  }

  private findLatestVerificationReceipt(remediationId: string): GovernedRemediationVerificationReceipt | undefined {
    return this.repository
      .listReceipts(remediationId)
      .filter((receipt): receipt is GovernedRemediationVerificationReceipt => receipt.kind === "verification")
      .at(-1);
  }

  private findReceipt(receiptId: string): GovernedRemediationReceipt | undefined {
    try {
      return this.repository.getReceipt(receiptId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private findFailure(failureId: string): GovernedRemediationFailure | undefined {
    try {
      return this.repository.getFailure(failureId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private findReconciliation(reconciliationId: string): GovernedRemediationReconciliation | undefined {
    try {
      return this.repository.getReconciliation(reconciliationId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private async transition(
    current: GovernedRemediationStoredState,
    state: GovernedRemediationState,
    patch: Partial<
      Pick<
        GovernedRemediationStateRecord,
        | "promptId"
        | "promptExpiresAt"
        | "approvalId"
        | "effectId"
        | "latestReceiptId"
        | "failureId"
        | "reconciliationId"
      >
    >,
    suffix: string,
  ): Promise<GovernedRemediationStoredState> {
    const next: GovernedRemediationStateRecord = {
      ...current.record,
      ...patch,
      state,
      revision: current.record.revision + 1,
      updatedAt: logicalTime(current.record.updatedAt),
    };
    try {
      return this.repository.transitionState({
        ownerId: current.ownerId,
        expectedRevision: current.record.revision,
        next,
        idempotencyKey: operationKey(
          `transition-${current.record.revision}-${state}-${suffix}`,
          current.record.remediationId,
        ),
        recordedAt: next.updatedAt,
      }).record;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const latest = this.repository.getState(current.record.remediationId);
      if (latest.record.revision > current.record.revision) return latest;
      throw error;
    }
  }

  private transitionReconciliation(
    current: GovernedRemediationReconciliation,
    state: GovernedRemediationReconciliation["state"],
    patch: Pick<GovernedRemediationReconciliation, "observation" | "ownerRevisionObserved" | "resolutionReceiptId">,
  ): GovernedRemediationReconciliation {
    if (current.state === state && current.resolutionReceiptId === patch.resolutionReceiptId) return current;
    const next: GovernedRemediationReconciliation = {
      ...current,
      ...patch,
      state,
      revision: current.revision + 1,
      updatedAt: logicalTime(current.updatedAt),
    };
    try {
      return this.repository.transitionReconciliation({
        expectedRevision: current.revision,
        next,
        idempotencyKey: operationKey(`reconciliation-${state}`, current.reconciliationId),
        recordedAt: next.updatedAt,
      }).record;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const latest = this.repository.getReconciliation(current.reconciliationId);
      if (latest.revision > current.revision) return latest;
      throw error;
    }
  }

  private quarantineOrManual(
    current: GovernedRemediationReconciliation,
    state: "quarantined" | "manual_required",
    observation: GovernedRemediationReconciliationObservation = "unknown",
  ): GovernedRemediationReconciliation {
    if (current.state === state) return current;
    return this.transitionReconciliation(current, state, {
      observation,
      ownerRevisionObserved: current.ownerRevisionObserved,
      resolutionReceiptId: null,
    });
  }

  private resolveStored(state: GovernedRemediationStoredState): GovernedRemediationRecipeResolution {
    const resolution = this.registry.resolveStored({
      recipeId: state.record.recipeId,
      recipeVersion: state.record.recipeVersion,
      deploymentProfile: this.deploymentProfile,
      scope: state.record.scope,
    });
    if (resolution.recipe.ownerId !== state.ownerId) {
      throw new GovernedRemediationRegistryError(
        "invalid_owner_binding",
        "Durable remediation owner does not match the current callable registry.",
      );
    }
    return resolution;
  }

  private async authorize(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    phase: GovernedRemediationAuthorityPhase,
    approvalId = state.record.approvalId,
    promptId = state.record.promptId,
  ): Promise<GovernedRemediationAuthorityResult> {
    try {
      const result = await this.authority.authorize({
        remediationId: state.record.remediationId,
        phase,
        recipeId: resolution.recipe.recipeId,
        recipeVersion: resolution.recipe.recipeVersion,
        ownerId: resolution.recipe.ownerId,
        requestedCapabilityId: resolution.recipe.requestedCapabilityId,
        deploymentProfile: this.deploymentProfile,
        scope: state.record.scope,
        approvalId,
        promptId,
      });
      if (result.status === "authorized" && Object.keys(result).length === 1) return result;
      if (
        result.status === "denied" &&
        Object.keys(result).length === 2 &&
        (result.reason === "policy_denied" ||
          result.reason === "approval_missing_or_expired" ||
          result.reason === "prompt_expired")
      ) {
        return result;
      }
      return { status: "denied", reason: "policy_denied" };
    } catch {
      return { status: "denied", reason: "policy_denied" };
    }
  }

  private ownerContext(
    state: GovernedRemediationStoredState,
    resolution: GovernedRemediationRecipeResolution,
    operation: string,
    approvalId = state.record.approvalId,
    promptId = state.record.promptId,
  ): GovernedRemediationOwnerContext {
    return Object.freeze({
      remediationId: state.record.remediationId,
      recipe: resolution.recipe,
      scope: state.record.scope,
      effectId: state.record.effectId ?? effectId(state.record.remediationId),
      operationId: operationKey(operation, state.record.remediationId),
      expectedOwnerRevision: state.record.expectedOwnerRevision,
      approvalId,
      promptId,
    });
  }
}

function requiresPreapproval(resolution: GovernedRemediationRecipeResolution): boolean {
  return (
    resolution.recipe.preEffectApproval === "required_before_input" ||
    resolution.recipe.preEffectApproval === "required_before_apply"
  );
}

function assertStartReplay(
  stored: GovernedRemediationStoredState,
  resolution: GovernedRemediationRecipeResolution,
  attempted: GovernedRemediationStateRecord,
): void {
  const storedBindings = {
    ownerId: stored.ownerId,
    remediationId: stored.record.remediationId,
    workspaceId: stored.record.workspaceId,
    sessionId: stored.record.sessionId,
    sourceTurnId: stored.record.sourceTurnId,
    durableRunId: stored.record.durableRunId,
    blockedCheckpointId: stored.record.blockedCheckpointId,
    recipeId: stored.record.recipeId,
    recipeVersion: stored.record.recipeVersion,
    scope: stored.record.scope,
    expectedWaitingRunVersion: stored.record.expectedWaitingRunVersion,
    expectedOwnerRevision: stored.record.expectedOwnerRevision,
    createdAt: stored.record.createdAt,
  };
  const attemptedBindings = {
    ownerId: resolution.recipe.ownerId,
    remediationId: attempted.remediationId,
    workspaceId: attempted.workspaceId,
    sessionId: attempted.sessionId,
    sourceTurnId: attempted.sourceTurnId,
    durableRunId: attempted.durableRunId,
    blockedCheckpointId: attempted.blockedCheckpointId,
    recipeId: attempted.recipeId,
    recipeVersion: attempted.recipeVersion,
    scope: attempted.scope,
    expectedWaitingRunVersion: attempted.expectedWaitingRunVersion,
    expectedOwnerRevision: attempted.expectedOwnerRevision,
    createdAt: attempted.createdAt,
  };
  if (canonicalJsonString(storedBindings) !== canonicalJsonString(attemptedBindings)) {
    throw new ConflictError({ message: "Governed remediation start replay conflicts with durable authority." });
  }
}

function effectId(remediationId: string): string {
  return stableId("effect", remediationId, "apply");
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

function logicalTime(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1).toISOString();
}

function reconciliationResolution(
  observation: Exclude<GovernedRemediationReconciliationObservation, "effect_present_unverified" | "unknown">,
): GovernedRemediationReconciliationResolution {
  if (observation === "effect_absent") return "confirmed_no_effect";
  if (observation === "rolled_back") return "confirmed_rolled_back";
  return "confirmed_verified";
}

function reconciliationState(
  resolution: GovernedRemediationReconciliationResolution,
): Extract<GovernedRemediationReconciliation["state"], `resolved_${string}`> {
  if (resolution === "confirmed_no_effect") return "resolved_no_effect";
  if (resolution === "confirmed_rolled_back") return "resolved_rolled_back";
  return "resolved_verified";
}
