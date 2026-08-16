import { randomBytes, randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  PolicyViolationError,
  SemanticValidationError,
  ServiceUnavailableError,
  ValidationError,
  isChangePlanRequest,
  redactSecretText,
  type ChangePlanOrigin,
  type ChangePlanRecord,
  type ChangePlanRequest,
  type ChangePlanRequiredAction,
  type ChangePlanResponseInput,
  type ChangePlanStatus,
} from "@goatcitadel/contracts";
import type {
  ChangePlanRepositoryCreateInput,
  ChangePlanRepositoryListInput,
  ChangePlanRepositoryTransitionInput,
} from "@goatcitadel/storage";
import {
  EvolutionControlPlaneAdapterRegistry,
  type EvolutionControlPlaneActionFactory,
  type EvolutionControlPlaneAdapter,
  type EvolutionControlPlaneAdapterContext,
  type EvolutionControlPlaneAdapterOutcome,
  type EvolutionControlPlaneOwnerInputReceipt,
  type RegisteredEvolutionControlPlaneAdapter,
} from "./evolution-control-plane-adapter.js";

export interface EvolutionControlPlaneRepositoryPort {
  create(input: ChangePlanRepositoryCreateInput): Promise<ChangePlanRecord>;
  get(planId: string): Promise<ChangePlanRecord>;
  list(input: ChangePlanRepositoryListInput): Promise<ChangePlanRecord[]>;
  listActive(limit?: number): Promise<ChangePlanRecord[]>;
  transition(planId: string, input: ChangePlanRepositoryTransitionInput): Promise<ChangePlanRecord>;
}

export interface EvolutionControlPlaneActor {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly surface: "chat" | "settings" | "system";
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
}

export interface EvolutionControlPlaneCreateInput {
  readonly actor: EvolutionControlPlaneActor;
  readonly request: ChangePlanRequest;
  readonly idempotencyKey?: string;
  /** Compatibility owners may bind creation to the caller's exact CAS witness. */
  readonly expectedTargetRevision?: number;
}

export interface EvolutionControlPlaneServiceDependencies {
  readonly repository: EvolutionControlPlaneRepositoryPort;
  readonly adapters: EvolutionControlPlaneAdapterRegistry;
  readonly isEnabled?: () => boolean | Promise<boolean>;
  readonly appendAudit?: (event: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
  readonly publishRealtime?: (event: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
  readonly getApprovalDisposition?: (
    approvalId: string,
  ) =>
    | "approved"
    | "denied"
    | "pending"
    | "expired"
    | undefined
    | Promise<"approved" | "denied" | "pending" | "expired" | undefined>;
  /** Creates a canonical approval after exact plan confirmation for caution/danger effects. */
  readonly createApproval?: (plan: ChangePlanRecord) => string | Promise<string>;
}

export class EvolutionControlPlaneAdapterError extends Error {
  public constructor(
    message: string,
    public readonly disposition: "failed" | "manual_required" | "rolling_back" = "failed",
    public readonly code = "adapter_failed",
  ) {
    super(message);
    this.name = "EvolutionControlPlaneAdapterError";
  }
}

/**
 * Gateway-owned mutation authority for configuration and self-evolution.
 * Models and UI clients may create plans, but only this service can advance a
 * confirmed plan into an adapter's live mutation hook.
 */
export class EvolutionControlPlaneService {
  public constructor(private readonly deps: EvolutionControlPlaneServiceDependencies) {}

  /** Read-only rollout probe used by compatibility routes before choosing authority. */
  public async isEnabled(): Promise<boolean> {
    return this.deps.isEnabled ? await this.deps.isEnabled() : true;
  }

  public async create(input: EvolutionControlPlaneCreateInput): Promise<ChangePlanRecord> {
    await this.requireEnabled();
    const origin = normalizeOrigin(input.actor);
    if (!isChangePlanRequest(input.request)) {
      throw new ValidationError({ message: "Change Plan intent is not an allowlisted bounded shape." });
    }
    const adapter = this.requireAdapter(input.request.kind);
    const context = this.context(origin);
    const prepared = await adapter.prepare(context, input.request as never);
    const inspection = await adapter.inspect(context, input.request as never, prepared);
    const inputs = await adapter.describeInputs(context, input.request as never, prepared);
    await adapter.validate(context, input.request as never, prepared, inspection, inputs);
    if (
      input.expectedTargetRevision !== undefined &&
      prepared.target.expectedRevision !== input.expectedTargetRevision
    ) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "The Change Plan target changed before the compatibility request was prepared.",
        details: {
          resourceKind: prepared.target.ownerId,
          resourceId: prepared.target.resourceId,
          expectedRevision: input.expectedTargetRevision,
          currentRevision: prepared.target.expectedRevision,
        },
      });
    }
    validatePreparedAction(prepared.status, prepared.requiredAction);
    const record = await this.deps.repository.create({
      origin,
      request: input.request,
      adapter: { adapterId: adapter.adapterId, version: adapter.version },
      target: prepared.target,
      title: prepared.title,
      summary: prepared.summary,
      impact: prepared.impact,
      risk: prepared.risk,
      status: prepared.status,
      requiredAction: prepared.requiredAction,
      idempotencyKey: input.idempotencyKey ?? origin.requestId,
      approvalRefs: prepared.approvalRefs,
      evidenceRefs: prepared.evidenceRefs,
      rollbackRefs: prepared.rollbackRefs,
      result: prepared.result,
      expiresAt: prepared.expiresAt ?? defaultExpiry(prepared.status),
    });
    await this.signal("change_plan.created", record);
    return record;
  }

  public async get(actor: EvolutionControlPlaneActor, planId: string): Promise<ChangePlanRecord> {
    const plan = await this.deps.repository.get(requireIdentifier(planId, "planId"));
    assertVisible(plan, actor);
    return plan;
  }

  public async list(
    actor: EvolutionControlPlaneActor,
    input: Omit<ChangePlanRepositoryListInput, "workspaceId"> = {},
  ): Promise<ChangePlanRecord[]> {
    const workspaceId = requireIdentifier(actor.workspaceId, "workspaceId");
    const query = {
      workspaceId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    };
    if (!input.sessionId) return await this.deps.repository.list(query);
    const [bound, workspacePlans] = await Promise.all([
      this.deps.repository.list({ ...query, sessionId: input.sessionId }),
      this.deps.repository.list(query),
    ]);
    const merged = new Map<string, ChangePlanRecord>();
    for (const plan of [...bound, ...workspacePlans.filter((item) => !item.origin.sessionId)]) {
      merged.set(plan.planId, plan);
    }
    return [...merged.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input.limit ?? 100);
  }

  public async confirm(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
    actionNonce: string,
  ): Promise<ChangePlanRecord> {
    await this.requireEnabled();
    const current = await this.get(actor, planId);
    requireRevision(current, expectedRevision);
    const action = requirePendingAction(current, "confirmation", actionNonce);
    if (isExpired(current)) return await this.expire(current, actor.actorId);
    if (action.purpose === "rollback") {
      return await this.executeRollback(actor, current, actionNonce);
    }
    const adapter = this.requireMatchingAdapter(current);
    const context = this.context(current.origin);
    if (adapter.stage && (adapter.shouldStage?.(current) ?? true)) {
      const staging = await this.deps.repository.transition(current.planId, {
        expectedRevision: current.revision,
        status: "staging",
        actionNonce,
        requiredAction: null,
        eventType: "confirmed_for_staging",
        actorId: actor.actorId,
      });
      await this.signal("change_plan.staging", staging);
      try {
        const outcome = await adapter.stage(context, staging);
        return await this.persistOutcome(actor, adapter, staging, outcome);
      } catch (error) {
        return await this.settleAdapterFailure(actor, staging, error);
      }
    }
    if (current.risk !== "safe") {
      return await this.requestCanonicalApproval(actor, current, actionNonce);
    }
    return await this.executeApply(actor, adapter, current, actionNonce);
  }

  /** Compatibility seam for the original Chat route. The canonical API always supplies the nonce. */
  public async confirmLegacy(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
  ): Promise<ChangePlanRecord> {
    const current = await this.get(actor, planId);
    const nonce = current.requiredAction?.actionNonce;
    if (!nonce) throw new ConflictError({ message: "Change Plan no longer has a confirmable action." });
    return await this.confirm(actor, planId, expectedRevision, nonce);
  }

  public async respond(
    actor: EvolutionControlPlaneActor,
    planId: string,
    input: ChangePlanResponseInput,
  ): Promise<ChangePlanRecord> {
    await this.requireEnabled();
    const current = await this.get(actor, planId);
    requireRevision(current, input.expectedRevision);
    if (current.requiredAction?.kind === "approval") {
      const action = requirePendingAction(current, "approval", input.actionNonce);
      if (action.actionId !== input.actionId) {
        throw new ConflictError({ message: "Change Plan approval action changed before resume." });
      }
      if (Object.keys(input.values).length > 0) {
        throw new ValidationError({ message: "Approval resume does not accept form values." });
      }
      if (!action.approvalId) throw new ServiceUnavailableError("Change Plan approval binding is unavailable.");
      return await this.resumeApproved(actor, current.planId, current.revision, action.approvalId);
    }
    if (current.requiredAction?.kind === "artifact_review") {
      const action = requireArtifactReviewAction(current, input.actionNonce);
      if (action.actionId !== input.actionId) {
        throw new ConflictError({ message: "Change Plan artifact review changed before acknowledgement." });
      }
      if (Object.keys(input.values).length > 0) {
        throw new ValidationError({ message: "Artifact review acknowledgement does not accept form values." });
      }
      if (isExpired(current)) return await this.expire(current, actor.actorId);
      const adapter = this.requireMatchingAdapter(current);
      if (!adapter.reviewArtifacts) {
        throw new ServiceUnavailableError("This Change Plan adapter cannot acknowledge artifact review.");
      }
      const consumed = await this.deps.repository.transition(current.planId, {
        expectedRevision: current.revision,
        status: "staging",
        actionNonce: input.actionNonce,
        requiredAction: null,
        eventType: "artifact_review_acknowledged",
        actorId: actor.actorId,
        eventPayload: { actionId: input.actionId, artifactRefs: action.artifactRefs },
      });
      try {
        const outcome = await adapter.reviewArtifacts(this.context(current.origin), consumed, action.artifactRefs);
        return await this.persistOutcome(actor, adapter, consumed, outcome);
      } catch (error) {
        return await this.settleAdapterFailure(actor, consumed, error);
      }
    }
    const action = requirePendingAction(current, "public_form", input.actionNonce);
    if (action.actionId !== input.actionId) {
      throw new ConflictError({ message: "Change Plan form action changed before submission." });
    }
    if (isExpired(current)) return await this.expire(current, actor.actorId);
    validatePublicValues(action, input.values);
    const adapter = this.requireMatchingAdapter(current);
    if (!adapter.respond)
      throw new ServiceUnavailableError("This Change Plan adapter does not accept public form responses.");
    const consumed = await this.deps.repository.transition(current.planId, {
      expectedRevision: current.revision,
      status: "staging",
      actionNonce: input.actionNonce,
      requiredAction: null,
      eventType: "public_form_submitted",
      actorId: actor.actorId,
      eventPayload: { actionId: input.actionId, fieldIds: Object.keys(input.values).sort() },
    });
    try {
      const outcome = await adapter.respond(this.context(current.origin), consumed, input.values);
      return await this.persistOutcome(actor, adapter, consumed, outcome);
    } catch (error) {
      return await this.settleAdapterFailure(actor, consumed, error);
    }
  }

  /**
   * Resume from a Gateway-owned secure/OAuth/path flow. Public API clients do
   * not call this method and the receipt is reference-only by construction.
   */
  public async resumeOwnerInput(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
    actionNonce: string,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<ChangePlanRecord> {
    await this.requireEnabled();
    const current = await this.get(actor, planId);
    requireRevision(current, expectedRevision);
    if (!isOwnerInputActionKind(receipt.actionKind)) {
      throw new ValidationError({ message: "Change Plan owner input receipt kind is invalid." });
    }
    const action = requireOwnerInputAction(current, receipt.actionKind, actionNonce);
    if (action.actionId !== receipt.actionId) {
      throw new ConflictError({ message: "Change Plan owner input action changed before completion." });
    }
    validateOwnerInputReceipt(receipt);
    if (isExpired(current)) return await this.expire(current, actor.actorId);
    const adapter = this.requireMatchingAdapter(current);
    if (!adapter.resumeOwnerInput) {
      throw new ServiceUnavailableError("This Change Plan adapter cannot resume the dedicated owner input flow.");
    }
    const consumed = await this.deps.repository.transition(current.planId, {
      expectedRevision: current.revision,
      status: "staging",
      actionNonce,
      requiredAction: null,
      evidenceRefs: receipt.evidenceRefs,
      ...(receipt.ownerRevision !== undefined && receipt.ownerResourceId === current.target.resourceId
        ? { target: { ...current.target, expectedRevision: receipt.ownerRevision } }
        : {}),
      eventType: "owner_input_completed",
      actorId: actor.actorId,
      eventPayload: {
        actionId: receipt.actionId,
        actionKind: receipt.actionKind,
        ownerId: receipt.ownerId,
        ownerResourceId: receipt.ownerResourceId,
        ownerRevision: receipt.ownerRevision,
      },
    });
    try {
      const outcome = await adapter.resumeOwnerInput(this.context(current.origin), consumed, receipt);
      return await this.persistOutcome(actor, adapter, consumed, outcome);
    } catch (error) {
      return await this.settleAdapterFailure(actor, consumed, error);
    }
  }

  /** Approval callbacks must re-read the canonical approval owner before apply. */
  public async resumeApproved(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
    approvalId: string,
  ): Promise<ChangePlanRecord> {
    await this.requireEnabled();
    const current = await this.get(actor, planId);
    requireRevision(current, expectedRevision);
    if (current.status !== "awaiting_approval" || current.requiredAction?.kind !== "approval") {
      throw new ConflictError({ message: "Change Plan is not awaiting canonical approval." });
    }
    const normalizedApprovalId = requireIdentifier(approvalId, "approvalId");
    if (!current.requiredAction.approvalId || current.requiredAction.approvalId !== normalizedApprovalId) {
      throw new ConflictError({ message: "Change Plan approval binding changed before resume." });
    }
    if (!this.deps.getApprovalDisposition) {
      throw new ServiceUnavailableError("The canonical approval owner is unavailable.");
    }
    const disposition = await this.deps.getApprovalDisposition(normalizedApprovalId);
    if (disposition !== "approved") {
      if (disposition === "denied" || disposition === "expired") {
        throw new PolicyViolationError({
          message: `Change Plan approval is ${disposition}; the effect cannot be applied.`,
          details: { approvalId: normalizedApprovalId, disposition },
        });
      }
      throw new ConflictError({ message: "Change Plan approval is not resolved as approved." });
    }
    const adapter = this.requireMatchingAdapter(current);
    const resumesRollback = current.result?.failureCode === "rollback_approval_pending";
    if (resumesRollback && !adapter.rollback) {
      throw new ServiceUnavailableError("The approved rollback owner is unavailable.");
    }
    const applying = await this.deps.repository.transition(current.planId, {
      expectedRevision: current.revision,
      status: resumesRollback ? "rolling_back" : "applying",
      internal: true,
      requiredAction: null,
      approvalRefs: [normalizedApprovalId],
      eventType: resumesRollback ? "rollback_approval_verified" : "approval_verified_apply_started",
      actorId: actor.actorId,
      eventPayload: { approvalId: normalizedApprovalId },
    });
    await this.signal(resumesRollback ? "change_plan.rolling_back" : "change_plan.applying", applying);
    try {
      const outcome = resumesRollback
        ? await adapter.rollback!(this.context(current.origin), applying)
        : await adapter.apply(this.context(current.origin), applying);
      return await this.persistOutcome(
        actor,
        adapter,
        applying,
        outcome,
        resumesRollback ? "rollback_settled" : undefined,
      );
    } catch (error) {
      return await this.settleAdapterFailure(actor, applying, error, resumesRollback ? "rollback_failed" : undefined);
    }
  }

  public async cancel(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
    actionNonce?: string,
  ): Promise<ChangePlanRecord> {
    const current = await this.get(actor, planId);
    requireRevision(current, expectedRevision);
    if (["applying", "verifying", "monitoring", "rolling_back"].includes(current.status)) {
      throw new ConflictError({
        message: "This Change Plan crossed its live-effect boundary. Use rollback instead of cancellation.",
      });
    }
    const adapter = this.requireMatchingAdapter(current);
    if (adapter.discard) await adapter.discard(this.context(current.origin), current);
    const cancelled = await this.deps.repository.transition(current.planId, {
      expectedRevision,
      status: "cancelled",
      ...(current.requiredAction ? { actionNonce: actionNonce ?? current.requiredAction.actionNonce } : {}),
      eventType: "cancelled",
      actorId: actor.actorId,
    });
    await this.signal("change_plan.cancelled", cancelled);
    return cancelled;
  }

  public async requestRollback(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
  ): Promise<ChangePlanRecord> {
    const current = await this.get(actor, planId);
    requireRevision(current, expectedRevision);
    const adapter = this.requireMatchingAdapter(current);
    if (!adapter.rollback || current.rollbackRefs.length === 0) {
      throw new SemanticValidationError("This Change Plan has no verified rollback operation.");
    }
    if (!["completed", "applied", "manual_required", "failed"].includes(current.status)) {
      throw new ConflictError({ message: "Rollback can only be requested after a terminal effect outcome." });
    }
    const action = this.actions().confirmation({
      title: `Rollback ${current.title}`,
      confirmationText: "Apply only the recovery material already bound to this Change Plan.",
      purpose: "rollback",
    });
    const pending = await this.deps.repository.transition(current.planId, {
      expectedRevision,
      status: "awaiting_confirmation",
      internal: true,
      requiredAction: action,
      eventType: "rollback_requested",
      actorId: actor.actorId,
    });
    await this.signal("change_plan.rollback_requested", pending);
    return pending;
  }

  /**
   * Startup recovery inspects canonical owner state. It never calls apply and
   * therefore cannot duplicate an effect after an ambiguous process death.
   */
  public async reconcileActive(limit = 500): Promise<ChangePlanRecord[]> {
    const active = await this.deps.repository.listActive(limit);
    const reconciled: ChangePlanRecord[] = [];
    for (const plan of active) {
      if (
        isExpired(plan) &&
        ["draft", "awaiting_input", "awaiting_confirmation", "awaiting_approval"].includes(plan.status)
      ) {
        reconciled.push(await this.expire(plan, "gateway-recovery"));
        continue;
      }
      if (!["staging", "applying", "verifying", "monitoring", "rolling_back"].includes(plan.status)) continue;
      let adapter: EvolutionControlPlaneAdapter;
      try {
        adapter = this.requireMatchingAdapter(plan);
      } catch (error) {
        reconciled.push(await this.settleAdapterFailure({ ...plan.origin, actorId: "gateway-recovery" }, plan, error));
        continue;
      }
      try {
        const outcome = await adapter.reconcile(this.context(plan.origin), plan);
        const settled = await this.persistOutcome(
          { ...plan.origin, actorId: "gateway-recovery" },
          adapter,
          plan,
          outcome,
          "reconciled",
        );
        reconciled.push(settled);
      } catch (error) {
        reconciled.push(await this.settleAdapterFailure({ ...plan.origin, actorId: "gateway-recovery" }, plan, error));
      }
    }
    return reconciled;
  }

  private async executeApply(
    actor: EvolutionControlPlaneActor,
    adapter: EvolutionControlPlaneAdapter,
    plan: ChangePlanRecord,
    actionNonce?: string,
  ): Promise<ChangePlanRecord> {
    const applying =
      plan.status === "applying"
        ? plan
        : await this.deps.repository.transition(plan.planId, {
            expectedRevision: plan.revision,
            status: "applying",
            ...(actionNonce ? { actionNonce } : { internal: true }),
            requiredAction: null,
            eventType: "apply_started",
            actorId: actor.actorId,
          });
    await this.signal("change_plan.applying", applying);
    try {
      const outcome = await adapter.apply(this.context(plan.origin), applying);
      return await this.persistOutcome(actor, adapter, applying, outcome);
    } catch (error) {
      return await this.settleAdapterFailure(actor, applying, error);
    }
  }

  private async requestCanonicalApproval(
    actor: EvolutionControlPlaneActor,
    plan: ChangePlanRecord,
    actionNonce: string,
  ): Promise<ChangePlanRecord> {
    if (!this.deps.createApproval) {
      throw new ServiceUnavailableError("The canonical approval owner is unavailable for this Change Plan.");
    }
    const staging = await this.deps.repository.transition(plan.planId, {
      expectedRevision: plan.revision,
      status: "staging",
      actionNonce,
      requiredAction: null,
      eventType: "confirmed_for_approval",
      actorId: actor.actorId,
    });
    await this.signal("change_plan.staging", staging);
    try {
      const approvalId = requireIdentifier(await this.deps.createApproval(staging), "approvalId");
      const approvalAction = this.context(staging.origin).actions.approval({
        title: `Approve: ${staging.title}`,
        risk: staging.risk === "danger" ? "danger" : "caution",
        approvalId,
      });
      const awaiting = await this.deps.repository.transition(staging.planId, {
        expectedRevision: staging.revision,
        status: "awaiting_approval",
        internal: true,
        requiredAction: approvalAction,
        approvalRefs: [approvalId],
        eventType: "canonical_approval_requested",
        actorId: actor.actorId,
        eventPayload: { approvalId },
      });
      await this.signal("change_plan.awaiting_approval", awaiting);
      return awaiting;
    } catch (error) {
      return await this.settleAdapterFailure(actor, staging, error);
    }
  }

  private async persistOutcome(
    actor: EvolutionControlPlaneActor,
    adapter: EvolutionControlPlaneAdapter,
    plan: ChangePlanRecord,
    outcome: EvolutionControlPlaneAdapterOutcome,
    eventType = "adapter_settled",
  ): Promise<ChangePlanRecord> {
    validateOutcome(outcome);
    if (outcome.status === "verifying") {
      const verifying = await this.deps.repository.transition(
        plan.planId,
        transitionFromOutcome(plan, outcome, actor.actorId, eventType),
      );
      await this.signal("change_plan.verifying", verifying);
      if (!adapter.verify) {
        return await this.deps.repository.transition(verifying.planId, {
          expectedRevision: verifying.revision,
          status: "completed",
          internal: true,
          evidenceRefs: verifying.evidenceRefs,
          rollbackRefs: verifying.rollbackRefs,
          result: outcome.result ?? { summary: "The owner applied and verified the requested change." },
          eventType: "verification_completed",
          actorId: actor.actorId,
        });
      }
      try {
        const verifiedOutcome = await adapter.verify(this.context(plan.origin), verifying);
        return await this.persistOutcome(actor, adapter, verifying, verifiedOutcome, "verification_settled");
      } catch (error) {
        return await this.settleAdapterFailure(actor, verifying, error);
      }
    }
    const settled = await this.deps.repository.transition(
      plan.planId,
      transitionFromOutcome(plan, outcome, actor.actorId, eventType),
    );
    await this.signal(`change_plan.${settled.status}`, settled);
    if (settled.status === "awaiting_confirmation" && settled.requiredAction?.kind !== "confirmation") {
      throw new Error("Adapter returned awaiting_confirmation without a confirmation action.");
    }
    if (settled.status === "awaiting_approval" && settled.requiredAction?.kind !== "approval") {
      throw new Error("Adapter returned awaiting_approval without an approval action.");
    }
    if (settled.status === "awaiting_input" && !settled.requiredAction) {
      throw new Error("Adapter returned awaiting_input without an input action.");
    }
    if (settled.status === "awaiting_confirmation") return settled;
    if (settled.status === "awaiting_approval") return settled;
    if (settled.status === "awaiting_input") return settled;
    if (settled.status === "staging" || settled.status === "applying") return settled;
    return settled;
  }

  private async executeRollback(
    actor: EvolutionControlPlaneActor,
    plan: ChangePlanRecord,
    actionNonce: string,
  ): Promise<ChangePlanRecord> {
    const adapter = this.requireMatchingAdapter(plan);
    if (!adapter.rollback) throw new SemanticValidationError("This Change Plan adapter has no rollback operation.");
    const rollingBack = await this.deps.repository.transition(plan.planId, {
      expectedRevision: plan.revision,
      status: "rolling_back",
      actionNonce,
      requiredAction: null,
      eventType: "rollback_started",
      actorId: actor.actorId,
    });
    try {
      const outcome = await adapter.rollback(this.context(plan.origin), rollingBack);
      return await this.persistOutcome(actor, adapter, rollingBack, outcome, "rollback_settled");
    } catch (error) {
      return await this.settleAdapterFailure(actor, rollingBack, error, "rollback_failed");
    }
  }

  private async settleAdapterFailure(
    actor: Pick<EvolutionControlPlaneActor, "actorId">,
    plan: ChangePlanRecord,
    error: unknown,
    forcedStatus?: Extract<ChangePlanStatus, "rollback_failed">,
  ): Promise<ChangePlanRecord> {
    const typed = error instanceof EvolutionControlPlaneAdapterError ? error : undefined;
    const status =
      forcedStatus ??
      typed?.disposition ??
      (plan.status === "applying" || plan.status === "verifying" ? "manual_required" : "failed");
    const failed = await this.deps.repository.transition(plan.planId, {
      expectedRevision: plan.revision,
      status,
      internal: true,
      result: { summary: safeErrorSummary(error), failureCode: typed?.code ?? "adapter_failed" },
      eventType: status,
      actorId: actor.actorId,
    });
    await this.signal(`change_plan.${status}`, failed);
    return failed;
  }

  private async expire(plan: ChangePlanRecord, actorId: string): Promise<ChangePlanRecord> {
    const adapter = this.requireMatchingAdapter(plan);
    if (adapter.discard) await adapter.discard(this.context(plan.origin), plan);
    const expired = await this.deps.repository.transition(plan.planId, {
      expectedRevision: plan.revision,
      status: "failed",
      internal: true,
      result: { summary: "This Change Plan expired. Review a fresh plan before applying.", failureCode: "expired" },
      eventType: "expired",
      actorId,
    });
    await this.signal("change_plan.expired", expired);
    return expired;
  }

  private context(origin: ChangePlanOrigin): EvolutionControlPlaneAdapterContext {
    return { origin, actions: this.actions() };
  }

  private actions(): EvolutionControlPlaneActionFactory {
    const base = <K extends ChangePlanRequiredAction["kind"]>(kind: K, title: string) => ({
      kind,
      actionId: `action_${randomUUID()}`,
      actionNonce: randomBytes(32).toString("base64url"),
      title,
    });
    return {
      confirmation: (input) => ({
        ...base("confirmation", input.title),
        confirmationText: input.confirmationText,
        purpose: input.purpose ?? "apply",
      }),
      publicForm: (input) => ({
        ...base("public_form", input.title),
        fields: input.fields,
        ...(input.submitLabel ? { submitLabel: input.submitLabel } : {}),
      }),
      secureInput: (input) => ({
        ...base("secure_input", input.title),
        targetId: input.targetId,
        expiresAt: input.expiresAt,
        ...(input.fields ? { fields: input.fields } : {}),
      }),
      oauth: (input) => ({ ...base("oauth", input.title), targetId: input.targetId }),
      nativePathPicker: (input) => ({
        ...base("native_path_picker", input.title),
        purpose: "managed_source_registration",
      }),
      approval: (input) => ({
        ...base("approval", input.title),
        risk: input.risk,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      }),
      artifactReview: (input) => ({ ...base("artifact_review", input.title), artifactRefs: input.artifactRefs }),
    };
  }

  private requireAdapter(kind: ChangePlanRequest["kind"]): RegisteredEvolutionControlPlaneAdapter {
    try {
      return this.deps.adapters.get(kind);
    } catch {
      throw new ServiceUnavailableError(`The ${kind} Change Plan adapter is unavailable.`);
    }
  }

  private requireMatchingAdapter(plan: ChangePlanRecord): RegisteredEvolutionControlPlaneAdapter {
    const adapter = this.requireAdapter(plan.kind);
    if (adapter.adapterId !== plan.adapter.adapterId || adapter.version !== plan.adapter.version) {
      throw new EvolutionControlPlaneAdapterError(
        `Change Plan adapter ${plan.adapter.adapterId}@${plan.adapter.version} is unavailable for safe recovery.`,
        "manual_required",
        "adapter_version_unavailable",
      );
    }
    return adapter;
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw new ServiceUnavailableError("The Evolution Control Plane is disabled by rollout policy.");
    }
  }

  private async signal(event: string, plan: ChangePlanRecord): Promise<void> {
    const payload = {
      planId: plan.planId,
      workspaceId: plan.origin.workspaceId,
      sessionId: plan.origin.sessionId,
      kind: plan.kind,
      scope: plan.scope,
      status: plan.status,
      phase: plan.phase,
      revision: plan.revision,
      adapterId: plan.adapter.adapterId,
      adapterVersion: plan.adapter.version,
      targetOwnerId: plan.target.ownerId,
      targetResourceId: plan.target.resourceId,
      risk: plan.risk,
      approvalRefs: plan.approvalRefs,
      evidenceRefs: plan.evidenceRefs,
      rollbackRefs: plan.rollbackRefs,
    };
    try {
      await this.deps.appendAudit?.(event, payload);
    } catch {
      /* Preserve the append-only plan/events as authority when optional audit publication fails. */
    }
    try {
      await this.deps.publishRealtime?.(event, payload);
    } catch {
      /* Intentionally keep realtime best-effort because it is retained signal, not authority. */
    }
  }
}

export function createEvolutionControlPlaneRegistry(
  adapters: readonly EvolutionControlPlaneAdapter[],
): EvolutionControlPlaneAdapterRegistry {
  return new EvolutionControlPlaneAdapterRegistry(adapters);
}

function transitionFromOutcome(
  plan: ChangePlanRecord,
  outcome: EvolutionControlPlaneAdapterOutcome,
  actorId: string,
  eventType: string,
): ChangePlanRepositoryTransitionInput {
  return {
    expectedRevision: plan.revision,
    status: outcome.status,
    internal: true,
    requiredAction: outcome.requiredAction ?? null,
    approvalRefs: outcome.approvalRefs,
    evidenceRefs: outcome.evidenceRefs,
    rollbackRefs: outcome.rollbackRefs,
    result: outcome.result,
    target: outcome.target,
    eventType,
    actorId,
  };
}

function normalizeOrigin(actor: EvolutionControlPlaneActor): ChangePlanOrigin {
  return {
    surface: actor.surface,
    workspaceId: requireIdentifier(actor.workspaceId, "workspaceId"),
    ...(actor.sessionId ? { sessionId: requireIdentifier(actor.sessionId, "sessionId") } : {}),
    ...(actor.turnId ? { turnId: requireIdentifier(actor.turnId, "turnId") } : {}),
    actorId: requireIdentifier(actor.actorId, "actorId"),
    ...(actor.requestId ? { requestId: requireIdentifier(actor.requestId, "requestId") } : {}),
  };
}

function assertVisible(plan: ChangePlanRecord, actor: EvolutionControlPlaneActor): void {
  if (plan.origin.workspaceId !== requireIdentifier(actor.workspaceId, "workspaceId")) {
    throw new NotFoundError({ entity: "Change Plan", id: plan.planId });
  }
  if (actor.surface !== "system" && plan.origin.sessionId && plan.origin.sessionId !== actor.sessionId) {
    throw new NotFoundError({ entity: "Change Plan", id: plan.planId });
  }
}

function requireRevision(plan: ChangePlanRecord, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ field: "expectedRevision" });
  }
  if (plan.revision !== expectedRevision) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "This Change Plan changed elsewhere. Reload it before continuing.",
      details: {
        resourceKind: "change_plan",
        resourceId: plan.planId,
        expectedRevision,
        currentRevision: plan.revision,
      },
    });
  }
}

function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "confirmation",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "confirmation" }>;
function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "public_form",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "public_form" }>;
function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "approval",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "approval" }>;
function requirePendingAction(
  plan: ChangePlanRecord,
  kind: ChangePlanRequiredAction["kind"],
  actionNonce: string,
): ChangePlanRequiredAction {
  if (!plan.requiredAction || plan.requiredAction.kind !== kind) {
    throw new ConflictError({ message: `Change Plan is not awaiting ${kind.replaceAll("_", " ")}.` });
  }
  if (!actionNonce || actionNonce !== plan.requiredAction.actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return plan.requiredAction;
}

function requireOwnerInputAction(
  plan: ChangePlanRecord,
  kind: EvolutionControlPlaneOwnerInputReceipt["actionKind"],
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: EvolutionControlPlaneOwnerInputReceipt["actionKind"] }> {
  const action = plan.requiredAction;
  if (!action || action.kind !== kind || !isOwnerInputActionKind(action.kind)) {
    throw new ConflictError({ message: `Change Plan is not awaiting ${kind.replaceAll("_", " ")}.` });
  }
  if (!actionNonce || action.actionNonce !== actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return action;
}

function requireArtifactReviewAction(
  plan: ChangePlanRecord,
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "artifact_review" }> {
  const action = plan.requiredAction;
  if (!action || action.kind !== "artifact_review") {
    throw new ConflictError({ message: "Change Plan is not awaiting artifact review." });
  }
  if (!actionNonce || action.actionNonce !== actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return action;
}

function isOwnerInputActionKind(value: string): value is EvolutionControlPlaneOwnerInputReceipt["actionKind"] {
  return value === "secure_input" || value === "oauth" || value === "native_path_picker";
}

function validateOwnerInputReceipt(receipt: EvolutionControlPlaneOwnerInputReceipt): void {
  requireIdentifier(receipt.actionId, "ownerInput.actionId");
  requireIdentifier(receipt.ownerId, "ownerInput.ownerId");
  requireIdentifier(receipt.ownerResourceId, "ownerInput.ownerResourceId");
  if (
    receipt.ownerRevision !== undefined &&
    (!Number.isSafeInteger(receipt.ownerRevision) || receipt.ownerRevision < 1)
  ) {
    throw new ValidationError({ message: "Change Plan owner input revision is invalid." });
  }
  if (
    receipt.evidenceRefs &&
    (receipt.evidenceRefs.length > 64 || receipt.evidenceRefs.some((ref) => !ref.trim() || ref.length > 512))
  ) {
    throw new ValidationError({ message: "Change Plan owner input evidence references are invalid." });
  }
}

function validatePreparedAction(
  status: EvolutionControlPlaneAdapterOutcome["status"] | "manual_required",
  action: ChangePlanRequiredAction | undefined,
): void {
  if (status === "awaiting_confirmation" && action?.kind !== "confirmation") {
    throw new Error("Adapter prepared an awaiting_confirmation plan without a confirmation action.");
  }
  if (status === "awaiting_input" && !action) {
    throw new Error("Adapter prepared an awaiting_input plan without an input action.");
  }
}

function validateOutcome(outcome: EvolutionControlPlaneAdapterOutcome): void {
  if (outcome.status === "awaiting_confirmation" && outcome.requiredAction?.kind !== "confirmation") {
    throw new Error("Adapter outcome is missing its confirmation action.");
  }
  if (outcome.status === "awaiting_approval" && outcome.requiredAction?.kind !== "approval") {
    throw new Error("Adapter outcome is missing its approval action.");
  }
  if (outcome.status === "awaiting_input" && !outcome.requiredAction) {
    throw new Error("Adapter outcome is missing its input action.");
  }
}

function validatePublicValues(
  action: Extract<ChangePlanRequiredAction, { kind: "public_form" }>,
  values: Readonly<Record<string, string | number | boolean>>,
): void {
  const allowed = new Map(action.fields.map((field) => [field.fieldId, field]));
  for (const [fieldId, value] of Object.entries(values)) {
    const field = allowed.get(fieldId);
    if (!field) throw new ValidationError({ message: `Public form field ${fieldId} is not part of this Change Plan.` });
    if (
      /secret|password|token|credential|api.?key|oauth/iu.test(fieldId) &&
      field.valueSemantic !== "environment_reference"
    ) {
      throw new ValidationError({ message: "Secret-like fields must use the dedicated secure-input flow." });
    }
    if (
      field.valueSemantic === "environment_reference" &&
      (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(value))
    ) {
      throw new ValidationError({ message: `Public form field ${fieldId} must be an environment variable name.` });
    }
    if (typeof value === "string" && (value.length > 4_000 || /[\0]/u.test(value))) {
      throw new ValidationError({ message: `Public form field ${fieldId} is invalid.` });
    }
  }
  for (const field of action.fields) {
    if (field.required && values[field.fieldId] === undefined) {
      throw new ValidationError({ message: `Public form field ${field.fieldId} is required.` });
    }
  }
}

function isExpired(plan: ChangePlanRecord): boolean {
  return Boolean(plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now());
}

function defaultExpiry(status: ChangePlanStatus): string | undefined {
  if (!["draft", "awaiting_input", "awaiting_confirmation", "awaiting_approval"].includes(status)) return undefined;
  return new Date(Date.now() + 15 * 60 * 1_000).toISOString();
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/u.test(normalized)) {
    throw new ValidationError({ message: `Change Plan ${label} is invalid.` });
  }
  return normalized;
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "The requested change could not be completed.";
  return redactSecretText(message.replace(/[\r\n]+/gu, " ")).value.slice(0, 500);
}
