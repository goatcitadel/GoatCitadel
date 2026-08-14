import type {
  ChangePlanKind,
  ChangePlanOrigin,
  ChangePlanRecord,
  ChangePlanRequest,
  ChangePlanRequiredAction,
  ChangePlanResult,
  ChangePlanRisk,
  ChangePlanStatus,
  ChangePlanTargetRef,
} from "@goatcitadel/contracts";

export interface EvolutionControlPlaneActionFactory {
  confirmation(input: {
    title: string;
    confirmationText: string;
    purpose?: "apply" | "rollback";
  }): Extract<ChangePlanRequiredAction, { kind: "confirmation" }>;
  publicForm(input: {
    title: string;
    fields: Extract<ChangePlanRequiredAction, { kind: "public_form" }>["fields"];
    submitLabel?: string;
  }): Extract<ChangePlanRequiredAction, { kind: "public_form" }>;
  secureInput(input: {
    targetId: string;
    title: string;
    expiresAt: string;
    fields?: Extract<ChangePlanRequiredAction, { kind: "secure_input" }>["fields"];
  }): Extract<ChangePlanRequiredAction, { kind: "secure_input" }>;
  oauth(input: { targetId: string; title: string }): Extract<ChangePlanRequiredAction, { kind: "oauth" }>;
  nativePathPicker(input: { title: string }): Extract<ChangePlanRequiredAction, { kind: "native_path_picker" }>;
  approval(input: {
    title: string;
    risk: "caution" | "danger";
    approvalId?: string;
  }): Extract<ChangePlanRequiredAction, { kind: "approval" }>;
  artifactReview(input: {
    title: string;
    artifactRefs: readonly string[];
  }): Extract<ChangePlanRequiredAction, { kind: "artifact_review" }>;
}

export interface EvolutionControlPlaneAdapterContext {
  readonly origin: ChangePlanOrigin;
  readonly actions: EvolutionControlPlaneActionFactory;
}

export interface EvolutionControlPlanePreparedPlan {
  readonly target: ChangePlanTargetRef;
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly risk: ChangePlanRisk;
  readonly status: Extract<ChangePlanStatus, "awaiting_input" | "awaiting_confirmation" | "manual_required">;
  readonly requiredAction?: ChangePlanRequiredAction;
  readonly approvalRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly rollbackRefs?: readonly string[];
  readonly result?: ChangePlanResult;
  readonly expiresAt?: string;
}

/** Read-only owner snapshot exposed by every adapter at the registry boundary. */
export interface EvolutionControlPlaneInspection {
  readonly target: ChangePlanTargetRef;
  readonly risk: ChangePlanRisk;
  readonly evidenceRefs: readonly string[];
  readonly rollbackRefs: readonly string[];
}

/** Server-authored input contract. Values are never part of this descriptor. */
export interface EvolutionControlPlaneInputDescription {
  readonly requiredActionKind?: ChangePlanRequiredAction["kind"];
  readonly publicFieldIds: readonly string[];
  readonly secureOwnerRequired: boolean;
}

export interface EvolutionControlPlaneAdapterOutcome {
  readonly status: Extract<
    ChangePlanStatus,
    | "awaiting_input"
    | "awaiting_confirmation"
    | "awaiting_approval"
    | "verifying"
    | "monitoring"
    | "completed"
    | "manual_required"
    | "failed"
    | "rolling_back"
    | "rolled_back"
    | "rollback_failed"
  >;
  readonly requiredAction?: ChangePlanRequiredAction;
  readonly approvalRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly rollbackRefs?: readonly string[];
  readonly result?: ChangePlanResult;
  /** Updated owner revision/hash after a plan-controlled staging or input action. */
  readonly target?: ChangePlanTargetRef;
}

export interface EvolutionControlPlaneReconcileOutcome extends EvolutionControlPlaneAdapterOutcome {
  /** True only when owner state proves the approved effect committed. */
  readonly effectObserved: boolean;
}

/**
 * Sanitized receipt emitted by a dedicated secret, OAuth, or native picker
 * owner. It deliberately cannot carry the captured value or filesystem path.
 */
export interface EvolutionControlPlaneOwnerInputReceipt {
  readonly actionId: string;
  readonly actionKind: "secure_input" | "oauth" | "native_path_picker";
  readonly ownerId: string;
  readonly ownerResourceId: string;
  readonly ownerRevision?: number;
  readonly evidenceRefs?: readonly string[];
}

export interface EvolutionControlPlaneAdapter<Request extends ChangePlanRequest = ChangePlanRequest> {
  readonly adapterId: string;
  readonly version: number;
  readonly kinds: readonly Request["kind"][];
  /** Inspect the exact owner snapshot prepared for persistence without mutating it. */
  inspect?(
    context: EvolutionControlPlaneAdapterContext,
    request: Request,
    prepared: EvolutionControlPlanePreparedPlan,
  ): EvolutionControlPlaneInspection | Promise<EvolutionControlPlaneInspection>;
  /** Describe only server-known public/secure action shape, never captured values. */
  describeInputs?(
    context: EvolutionControlPlaneAdapterContext,
    request: Request,
    prepared: EvolutionControlPlanePreparedPlan,
  ): EvolutionControlPlaneInputDescription | Promise<EvolutionControlPlaneInputDescription>;
  /** Validate the prepared snapshot against the inspection and input contract. */
  validate?(
    context: EvolutionControlPlaneAdapterContext,
    request: Request,
    prepared: EvolutionControlPlanePreparedPlan,
    inspection: EvolutionControlPlaneInspection,
    inputs: EvolutionControlPlaneInputDescription,
  ): void | Promise<void>;
  prepare(context: EvolutionControlPlaneAdapterContext, request: Request): Promise<EvolutionControlPlanePreparedPlan>;
  /** Optional pre-apply worktree/artifact/approval staging. It must not mutate the live target. */
  stage?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /**
   * Selects whether the current exact confirmation advances through `stage`.
   * Adapters with a review-then-confirm flow use this to prevent the final
   * confirmation from replaying staging. Omission preserves the original
   * one-confirmation staging behavior.
   */
  shouldStage?(plan: ChangePlanRecord): boolean;
  /** The only adapter hook permitted to invoke the low-level mutation owner. */
  apply(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /** Optional post-apply proof. Absence means apply returned complete owner evidence. */
  verify?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /** Inspect canonical owner state after restart; this hook must never reapply an effect. */
  reconcile(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneReconcileOutcome>;
  /** Optional compensation bound to rollback material already stored on the plan. */
  rollback?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /** Deletes temporary owner material when a pre-effect plan is cancelled or expires. */
  discard?(context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): void | Promise<void>;
  /** Public non-secret forms only. Secure input, OAuth, and paths have dedicated routes. */
  respond?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    values: Readonly<Record<string, string | number | boolean>>,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /**
   * Acknowledges the exact immutable artifact set described by the current
   * server action. The generic response body must be empty; artifact content
   * and hashes are resolved from the owner links already bound to the plan.
   */
  reviewArtifacts?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    artifactRefs: readonly string[],
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
  /** Dedicated owners resume a plan with a sanitized reference-only receipt. */
  resumeOwnerInput?(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome>;
}

export type RegisteredEvolutionControlPlaneAdapter<Request extends ChangePlanRequest = ChangePlanRequest> =
  EvolutionControlPlaneAdapter<Request> &
    Required<Pick<EvolutionControlPlaneAdapter<Request>, "inspect" | "describeInputs" | "validate">>;

export class EvolutionControlPlaneAdapterRegistry {
  private readonly byKind = new Map<ChangePlanKind, RegisteredEvolutionControlPlaneAdapter>();

  public constructor(adapters: readonly EvolutionControlPlaneAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public register(adapter: EvolutionControlPlaneAdapter): void {
    if (
      !adapter.adapterId.trim() ||
      !Number.isSafeInteger(adapter.version) ||
      adapter.version < 1 ||
      adapter.kinds.length === 0
    ) {
      throw new TypeError("Evolution Control Plane adapter identity is invalid.");
    }
    const registered = installRequiredAdapterLifecycle(adapter);
    for (const kind of registered.kinds) {
      const existing = this.byKind.get(kind);
      if (existing) {
        throw new Error(
          `Change Plan kind ${kind} is already owned by adapter ${existing.adapterId}@${existing.version}.`,
        );
      }
      this.byKind.set(kind, registered);
    }
  }

  public get(kind: ChangePlanKind): RegisteredEvolutionControlPlaneAdapter {
    const adapter = this.byKind.get(kind);
    if (!adapter) throw new Error(`No Evolution Control Plane adapter is registered for ${kind}.`);
    return adapter;
  }

  public list(): ReadonlyArray<{ adapterId: string; version: number; kinds: readonly ChangePlanKind[] }> {
    const grouped = new Map<RegisteredEvolutionControlPlaneAdapter, ChangePlanKind[]>();
    for (const [kind, adapter] of this.byKind) {
      const kinds = grouped.get(adapter) ?? [];
      kinds.push(kind);
      grouped.set(adapter, kinds);
    }
    return [...grouped.entries()]
      .map(([adapter, kinds]) => ({ adapterId: adapter.adapterId, version: adapter.version, kinds: kinds.sort() }))
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  }
}

function installRequiredAdapterLifecycle(
  adapter: EvolutionControlPlaneAdapter,
): RegisteredEvolutionControlPlaneAdapter {
  const mutable = adapter as EvolutionControlPlaneAdapter & {
    inspect?: RegisteredEvolutionControlPlaneAdapter["inspect"];
    describeInputs?: RegisteredEvolutionControlPlaneAdapter["describeInputs"];
    validate?: RegisteredEvolutionControlPlaneAdapter["validate"];
  };
  mutable.inspect ??= (_context, _request, prepared) => ({
    target: prepared.target,
    risk: prepared.risk,
    evidenceRefs: [...(prepared.evidenceRefs ?? [])],
    rollbackRefs: [...(prepared.rollbackRefs ?? [])],
  });
  mutable.describeInputs ??= (_context, _request, prepared) => ({
    requiredActionKind: prepared.requiredAction?.kind,
    publicFieldIds:
      prepared.requiredAction?.kind === "public_form"
        ? prepared.requiredAction.fields.map((field) => field.fieldId)
        : [],
    secureOwnerRequired:
      prepared.requiredAction?.kind === "secure_input" ||
      prepared.requiredAction?.kind === "oauth" ||
      prepared.requiredAction?.kind === "native_path_picker",
  });
  mutable.validate ??= (_context, _request, prepared, inspection, inputs) => {
    assertPreparedAdapterSnapshot(prepared, inspection, inputs);
  };
  return mutable as RegisteredEvolutionControlPlaneAdapter;
}

function assertPreparedAdapterSnapshot(
  prepared: EvolutionControlPlanePreparedPlan,
  inspection: EvolutionControlPlaneInspection,
  inputs: EvolutionControlPlaneInputDescription,
): void {
  const target = prepared.target;
  for (const [label, value] of [
    ["ownerId", target.ownerId],
    ["resourceId", target.resourceId],
  ] as const) {
    if (!value.trim() || value.length > 512 || /[\r\n\0]/u.test(value)) {
      throw new TypeError(`Evolution adapter prepared an invalid target ${label}.`);
    }
  }
  if (
    target.expectedRevision !== undefined &&
    (!Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 1)
  ) {
    throw new TypeError("Evolution adapter prepared an invalid target revision.");
  }
  if (
    inspection.target.ownerId !== target.ownerId ||
    inspection.target.resourceId !== target.resourceId ||
    inspection.target.expectedRevision !== target.expectedRevision ||
    inspection.target.expectedHash !== target.expectedHash ||
    inspection.risk !== prepared.risk
  ) {
    throw new TypeError("Evolution adapter inspection drifted from its prepared owner snapshot.");
  }
  if (inputs.requiredActionKind !== prepared.requiredAction?.kind) {
    throw new TypeError("Evolution adapter input description drifted from its server action.");
  }
  const expectedPublicFields =
    prepared.requiredAction?.kind === "public_form"
      ? prepared.requiredAction.fields.map((field) => field.fieldId).sort()
      : [];
  const describedPublicFields = [...new Set(inputs.publicFieldIds)].sort();
  if (
    expectedPublicFields.length !== describedPublicFields.length ||
    expectedPublicFields.some((fieldId, index) => fieldId !== describedPublicFields[index])
  ) {
    throw new TypeError("Evolution adapter public input description is incomplete.");
  }
  const expectedSecureOwner =
    prepared.requiredAction?.kind === "secure_input" ||
    prepared.requiredAction?.kind === "oauth" ||
    prepared.requiredAction?.kind === "native_path_picker";
  if (inputs.secureOwnerRequired !== expectedSecureOwner) {
    throw new TypeError("Evolution adapter secure-input custody description is invalid.");
  }
}
