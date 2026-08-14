import {
  ConflictError,
  SemanticValidationError,
  ServiceUnavailableError,
  type ChangePlanRecord,
  type ChangePlanRuntimeRemediationRequest,
  type GovernedRemediationState,
} from "@goatcitadel/contracts";
import type { GovernedRemediationStoredState } from "@goatcitadel/storage";
import type { ContinueGovernedRemediationInput } from "./governed-remediation-coordinator.js";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneReconcileOutcome,
} from "./evolution-control-plane-adapter.js";

export interface RuntimeRemediationChangePlanAdapterDependencies {
  readonly getState: (
    remediationId: string,
  ) => GovernedRemediationStoredState | Promise<GovernedRemediationStoredState>;
  /**
   * The durable remediation owner. Omit it when only the remediation ledger is
   * available; plans then remain inspectable and stop at manual_required.
   */
  readonly continueRemediation?: (
    input: ContinueGovernedRemediationInput,
  ) => GovernedRemediationStoredState | Promise<GovernedRemediationStoredState>;
}

/**
 * User-facing Change Plan projection over the existing durable remediation
 * state machine. The adapter never implements a repair itself: it either asks
 * the canonical coordinator to continue an exact revision or observes the
 * coordinator's durable state during recovery.
 */
export class RuntimeRemediationChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanRuntimeRemediationRequest> {
  public readonly adapterId = "runtime-remediation";
  public readonly version = 1;
  public readonly kinds = ["runtime_remediation"] as const;

  public constructor(private readonly deps: RuntimeRemediationChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanRuntimeRemediationRequest) {
    const state = await this.deps.getState(request.remediationId);
    assertOrigin(state, context);
    const terminal = terminalOutcome(state);
    if (terminal) {
      return {
        target: target(state),
        title: title(state),
        summary: terminal.result?.summary ?? "The linked remediation is already terminal.",
        impact: "No new remediation effect will be started by this Change Plan.",
        risk: "caution" as const,
        status: "manual_required" as const,
        evidenceRefs: evidenceRefs(state),
        result: terminal.result,
      };
    }
    if (!this.deps.continueRemediation || requiresDedicatedRemediationInput(state.record.state)) {
      return {
        target: target(state),
        title: title(state),
        summary: this.deps.continueRemediation
          ? "The durable remediation owner requires its dedicated secure input or activation approval flow."
          : "The durable remediation record is available, but its production coordinator is not registered.",
        impact: "The Control Plane will not infer, replay, or replace the durable remediation owner.",
        risk: "caution" as const,
        status: "manual_required" as const,
        evidenceRefs: evidenceRefs(state),
        result: {
          summary: this.deps.continueRemediation
            ? "Continue this repair from the canonical blocked-turn remediation prompt."
            : "A production GovernedRemediationCoordinator must be registered before this repair can advance.",
          failureCode: this.deps.continueRemediation
            ? "remediation_owner_input_required"
            : "remediation_coordinator_unavailable",
        },
      };
    }
    return {
      target: target(state),
      title: title(state),
      summary: `Continue the exact ${state.record.recipeId}@${state.record.recipeVersion} remediation from revision ${state.record.revision}.`,
      impact: "The existing durable repair owner may apply its approval-gated effect and resume the bound waiting run.",
      risk: "caution" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: "Confirm governed remediation",
        confirmationText:
          "Continue only this exact durable remediation revision. The canonical approval and repair owners remain authoritative.",
      }),
      evidenceRefs: evidenceRefs(state),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  public async apply(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    const current = await this.deps.getState(request.remediationId);
    assertOrigin(current, context);
    assertTarget(plan, current);
    if (!this.deps.continueRemediation) {
      throw new ServiceUnavailableError("The durable remediation coordinator is unavailable.");
    }
    const approvalId = plan.approvalRefs.at(-1);
    if (!approvalId) {
      throw new ConflictError({ message: "Governed remediation requires the exact Change Plan approval binding." });
    }
    if (requiresDedicatedRemediationInput(current.record.state)) {
      return manualInputOutcome(current);
    }
    if (!canContinue(current.record.state)) {
      return observeOutcome(current);
    }
    const next = await this.deps.continueRemediation({
      remediationId: current.record.remediationId,
      requesterActorId: current.record.requesterActorId,
      workspaceId: current.record.workspaceId,
      expectedStateRevision: current.record.revision,
      commandIdempotencyKey: `change-plan:${plan.planId}:revision:${plan.revision}`,
      action:
        current.record.state === "awaiting_activation_approval"
          ? { kind: "approve_activation", approvalId }
          : { kind: "approve_pre_effect", approvalId },
    });
    return observeOutcome(next);
  }

  public async reconcile(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneReconcileOutcome> {
    const request = requireRequest(plan);
    const current = await this.deps.getState(request.remediationId);
    assertOrigin(current, context);
    const outcome = observeOutcome(current);
    return {
      ...outcome,
      effectObserved:
        current.record.state === "completed" ||
        current.record.state === "verified" ||
        current.record.state === "resuming" ||
        current.record.state === "reconciling_resume",
    };
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanRuntimeRemediationRequest {
  if (plan.request.kind !== "runtime_remediation") {
    throw new SemanticValidationError("Runtime remediation Change Plan kind drifted.");
  }
  return plan.request;
}

function title(state: GovernedRemediationStoredState): string {
  return `Repair ${state.record.recipeId}`;
}

function target(state: GovernedRemediationStoredState) {
  return {
    ownerId: "governed_remediation_coordinator",
    resourceId: state.record.remediationId,
    expectedRevision: state.record.revision,
    expectedHash: state.record.recipeSha256,
  };
}

function evidenceRefs(state: GovernedRemediationStoredState): string[] {
  return [
    `governed_remediation:${state.record.remediationId}:revision:${state.record.revision}`,
    `remediation_recipe:${state.record.recipeId}@${state.record.recipeVersion}:sha256:${state.record.recipeSha256}`,
    `durable_run:${state.record.durableRunId}`,
    `durable_checkpoint:${state.record.blockedCheckpointId}`,
    ...(state.record.latestReceiptId ? [`governed_remediation_receipt:${state.record.latestReceiptId}`] : []),
  ];
}

function assertOrigin(state: GovernedRemediationStoredState, context: EvolutionControlPlaneAdapterContext): void {
  if (state.record.workspaceId !== context.origin.workspaceId) {
    throw new SemanticValidationError("The governed remediation belongs to a different workspace.");
  }
  if (context.origin.sessionId && state.record.sessionId !== context.origin.sessionId) {
    throw new SemanticValidationError("The governed remediation belongs to a different Chat session.");
  }
}

function assertTarget(plan: ChangePlanRecord, state: GovernedRemediationStoredState): void {
  if (
    plan.target.resourceId !== state.record.remediationId ||
    plan.target.expectedRevision !== state.record.revision ||
    plan.target.expectedHash !== state.record.recipeSha256
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "The durable remediation changed after this Change Plan was prepared.",
      details: {
        resourceKind: "governed_remediation",
        resourceId: state.record.remediationId,
        expectedRevision: plan.target.expectedRevision,
        currentRevision: state.record.revision,
      },
    });
  }
}

function canContinue(state: GovernedRemediationState): boolean {
  return (
    state === "blocked" ||
    state === "offered" ||
    state === "awaiting_preapproval" ||
    state === "awaiting_activation_approval"
  );
}

function requiresDedicatedRemediationInput(state: GovernedRemediationState): boolean {
  return state === "awaiting_secure_input";
}

function observeOutcome(state: GovernedRemediationStoredState): EvolutionControlPlaneAdapterOutcome {
  const terminal = terminalOutcome(state);
  if (terminal) return { ...terminal, target: target(state), evidenceRefs: evidenceRefs(state) };
  if (requiresDedicatedRemediationInput(state.record.state)) return manualInputOutcome(state);
  if (state.record.state === "awaiting_activation_approval") {
    return {
      status: "manual_required",
      target: target(state),
      evidenceRefs: evidenceRefs(state),
      result: {
        summary: "The remediation owner requires a distinct activation approval; continue from its canonical prompt.",
        failureCode: "remediation_activation_approval_required",
      },
    };
  }
  return {
    status: "monitoring",
    target: target(state),
    evidenceRefs: evidenceRefs(state),
    result: { summary: `The durable remediation owner is currently ${state.record.state.replaceAll("_", " ")}.` },
  };
}

function manualInputOutcome(state: GovernedRemediationStoredState): EvolutionControlPlaneAdapterOutcome {
  return {
    status: "manual_required",
    target: target(state),
    evidenceRefs: evidenceRefs(state),
    result: {
      summary:
        "The remediation owner requires its dedicated secure input flow; generic Change Plan forms cannot carry that value.",
      failureCode: "remediation_owner_input_required",
    },
  };
}

function terminalOutcome(state: GovernedRemediationStoredState): EvolutionControlPlaneAdapterOutcome | undefined {
  switch (state.record.state) {
    case "completed":
      return { status: "completed", result: { summary: "The durable remediation and bound run resume completed." } };
    case "declined":
    case "expired":
    case "failed":
      return {
        status: "failed",
        result: {
          summary: `The durable remediation is ${state.record.state}.`,
          failureCode: `remediation_${state.record.state}`,
        },
      };
    case "manual_required":
      return {
        status: "manual_required",
        result: {
          summary: "The durable remediation requires manual operator work.",
          failureCode: "remediation_manual_required",
        },
      };
    case "rolled_back":
      return { status: "rolled_back", result: { summary: "The durable remediation owner restored its prior state." } };
    case "rollback_failed":
      return {
        status: "rollback_failed",
        result: { summary: "The durable remediation rollback failed.", failureCode: "remediation_rollback_failed" },
      };
    default:
      return undefined;
  }
}
