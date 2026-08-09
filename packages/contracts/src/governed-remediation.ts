import type { DeploymentProfile } from "./integrations.js";

/**
 * Contract-only foundation for the broader governed-remediation owner.
 *
 * The currently shipped secure-search configuration flow continues to use its
 * existing Chat and durable-reservation contracts. These additive v1
 * contracts describe the generic owner that may later coordinate other
 * allowlisted repair classes. They do not make those classes callable and do
 * not establish generic self-repair parity.
 *
 * Every shape is intentionally secret-free and exact. In particular, recipes
 * cannot carry commands or arbitrary arguments, and durable records cannot
 * carry credential bytes, OAuth codes, provider responses, or free-form error
 * payloads.
 */

export const GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION = "goatcitadel.governed-remediation-scope.v1" as const;
export const GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION = "goatcitadel.governed-remediation-recipe.v1" as const;
export const GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION = "goatcitadel.governed-remediation-state.v1" as const;
export const GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION = "goatcitadel.governed-remediation-receipt.v1" as const;
export const GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION = "goatcitadel.governed-remediation-failure.v1" as const;
export const GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION =
  "goatcitadel.governed-remediation-reconciliation.v1" as const;

export const GOVERNED_REMEDIATION_SCOPE_KINDS = [
  "installation",
  "workspace",
  "citadel",
  "actor",
  "connection",
] as const;
export type GovernedRemediationScopeKind = (typeof GOVERNED_REMEDIATION_SCOPE_KINDS)[number];

/** Exact owner key. Scope is never inferred from the caller's active UI state. */
export interface GovernedRemediationScope {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly scopeKind: GovernedRemediationScopeKind;
  readonly scopeId: string;
  readonly targetId: string;
}

export const GOVERNED_REMEDIATION_REPAIR_CLASSES = [
  "credential",
  "oauth_connection",
  "declarative_configuration",
  "managed_dependency",
  "owned_service",
  "durable_data_or_configuration",
  "capability_enablement",
  "policy_auth_or_host_prerequisite",
  "product_source_or_binary",
] as const;
export type GovernedRemediationRepairClass = (typeof GOVERNED_REMEDIATION_REPAIR_CLASSES)[number];

export const GOVERNED_REMEDIATION_EXECUTION_MODES = ["governed", "manual_required"] as const;
export type GovernedRemediationExecutionMode = (typeof GOVERNED_REMEDIATION_EXECUTION_MODES)[number];

export const GOVERNED_REMEDIATION_INPUT_KINDS = [
  "none",
  "secure_credential",
  "oauth_redirect",
  "operator_confirmation",
] as const;
export type GovernedRemediationInputKind = (typeof GOVERNED_REMEDIATION_INPUT_KINDS)[number];

export const GOVERNED_REMEDIATION_PRE_EFFECT_APPROVALS = [
  "not_applicable",
  "not_required",
  "required_before_input",
  "required_before_apply",
] as const;
export type GovernedRemediationPreEffectApproval = (typeof GOVERNED_REMEDIATION_PRE_EFFECT_APPROVALS)[number];

export const GOVERNED_REMEDIATION_ACTIVATION_APPROVALS = ["not_applicable", "not_required", "required"] as const;
export type GovernedRemediationActivationApproval = (typeof GOVERNED_REMEDIATION_ACTIVATION_APPROVALS)[number];

export const GOVERNED_REMEDIATION_ROLLBACK_STRATEGIES = [
  "restore_previous",
  "remove_candidate",
  "transactional",
  "safe_stop",
  "manual_required",
] as const;
export type GovernedRemediationRollbackStrategy = (typeof GOVERNED_REMEDIATION_ROLLBACK_STRATEGIES)[number];

/**
 * Registry material authored by a trusted owner. Absence from the Gateway's
 * allowlisted registry must remain non-callable even when this shape validates.
 */
export interface GovernedRemediationRecipe {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly repairClass: GovernedRemediationRepairClass;
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly executionMode: GovernedRemediationExecutionMode;
  readonly allowedScopeKinds: readonly GovernedRemediationScopeKind[];
  readonly allowedDeploymentProfiles: readonly DeploymentProfile[];
  readonly inputKind: GovernedRemediationInputKind;
  readonly preEffectApproval: GovernedRemediationPreEffectApproval;
  readonly activationApproval: GovernedRemediationActivationApproval;
  readonly verificationProbeId: string | null;
  readonly rollbackStrategy: GovernedRemediationRollbackStrategy;
  /** One initial attempt plus, at most, one recipe-authorized retry. */
  readonly maxApplyAttempts: 0 | 1 | 2;
}

export const GOVERNED_REMEDIATION_STATES = [
  "blocked",
  "offered",
  "awaiting_preapproval",
  "awaiting_secure_input",
  "applying",
  "verifying",
  "credential_verified",
  "awaiting_activation_approval",
  "activating",
  "verified",
  "resuming",
  "completed",
  "declined",
  "expired",
  "manual_required",
  "failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
] as const;
export type GovernedRemediationState = (typeof GOVERNED_REMEDIATION_STATES)[number];

const GOVERNED_REMEDIATION_STATE_TRANSITIONS: Readonly<
  Record<GovernedRemediationState, readonly GovernedRemediationState[]>
> = Object.freeze({
  blocked: Object.freeze<GovernedRemediationState[]>(["offered", "manual_required", "failed"]),
  offered: Object.freeze<GovernedRemediationState[]>([
    "awaiting_preapproval",
    "awaiting_secure_input",
    "applying",
    "declined",
    "expired",
    "manual_required",
    "failed",
  ]),
  awaiting_preapproval: Object.freeze<GovernedRemediationState[]>([
    "awaiting_secure_input",
    "applying",
    "declined",
    "expired",
    "failed",
  ]),
  awaiting_secure_input: Object.freeze<GovernedRemediationState[]>(["applying", "declined", "expired", "failed"]),
  applying: Object.freeze<GovernedRemediationState[]>(["verifying", "rolling_back", "failed"]),
  verifying: Object.freeze<GovernedRemediationState[]>(["credential_verified", "verified", "rolling_back"]),
  credential_verified: Object.freeze<GovernedRemediationState[]>([
    "awaiting_activation_approval",
    "activating",
    "verified",
  ]),
  awaiting_activation_approval: Object.freeze<GovernedRemediationState[]>([
    "activating",
    "declined",
    "expired",
    "failed",
  ]),
  activating: Object.freeze<GovernedRemediationState[]>(["verified", "rolling_back"]),
  verified: Object.freeze<GovernedRemediationState[]>(["resuming"]),
  resuming: Object.freeze<GovernedRemediationState[]>(["completed", "failed"]),
  completed: Object.freeze<GovernedRemediationState[]>([]),
  declined: Object.freeze<GovernedRemediationState[]>([]),
  expired: Object.freeze<GovernedRemediationState[]>([]),
  manual_required: Object.freeze<GovernedRemediationState[]>([]),
  failed: Object.freeze<GovernedRemediationState[]>([]),
  rolling_back: Object.freeze<GovernedRemediationState[]>(["rolled_back", "rollback_failed"]),
  rolled_back: Object.freeze<GovernedRemediationState[]>([]),
  rollback_failed: Object.freeze<GovernedRemediationState[]>([]),
});

export function governedRemediationStateCanTransition(
  from: GovernedRemediationState,
  to: GovernedRemediationState,
): boolean {
  return GOVERNED_REMEDIATION_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Secret-free durable projection. The Gateway/storage pair remains its owner. */
export interface GovernedRemediationStateRecord {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION;
  readonly remediationId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceTurnId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly scope: GovernedRemediationScope;
  readonly state: GovernedRemediationState;
  readonly revision: number;
  readonly expectedWaitingRunVersion: number;
  readonly expectedOwnerRevision: string | null;
  readonly promptId: string | null;
  readonly promptExpiresAt: string | null;
  readonly approvalId: string | null;
  readonly effectId: string | null;
  readonly latestReceiptId: string | null;
  readonly failureId: string | null;
  readonly reconciliationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const GOVERNED_REMEDIATION_RECEIPT_KINDS = [
  "application",
  "verification",
  "rollback",
  "resume",
  "reconciliation",
] as const;
export type GovernedRemediationReceiptKind = (typeof GOVERNED_REMEDIATION_RECEIPT_KINDS)[number];

interface GovernedRemediationReceiptBase {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly remediationId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly scope: GovernedRemediationScope;
  readonly kind: GovernedRemediationReceiptKind;
  readonly recordedAt: string;
}

export interface GovernedRemediationApplicationReceipt extends GovernedRemediationReceiptBase {
  readonly kind: "application";
  readonly ownerId: string;
  readonly effectId: string;
  readonly ownerRevisionBefore: string | null;
  readonly ownerRevisionAfter: string;
}

export interface GovernedRemediationVerificationReceipt extends GovernedRemediationReceiptBase {
  readonly kind: "verification";
  readonly applicationReceiptId: string;
  readonly probeId: string;
  readonly probeResult: "accepted";
  readonly ownerRevisionObserved: string;
}

export interface GovernedRemediationRollbackReceipt extends GovernedRemediationReceiptBase {
  readonly kind: "rollback";
  readonly applicationReceiptId: string;
  readonly rollbackStrategy: Exclude<GovernedRemediationRollbackStrategy, "manual_required">;
  readonly outcome: "rolled_back";
  readonly ownerRevisionAfter: string;
}

export interface GovernedRemediationResumeReceipt extends GovernedRemediationReceiptBase {
  readonly kind: "resume";
  readonly verificationReceiptId: string;
  readonly durableRunId: string;
  readonly blockedCheckpointId: string;
  readonly resumedRunVersion: number;
}

export const GOVERNED_REMEDIATION_RECONCILIATION_RESOLUTIONS = [
  "confirmed_no_effect",
  "confirmed_rolled_back",
  "confirmed_verified",
] as const;
export type GovernedRemediationReconciliationResolution =
  (typeof GOVERNED_REMEDIATION_RECONCILIATION_RESOLUTIONS)[number];

export interface GovernedRemediationReconciliationReceipt extends GovernedRemediationReceiptBase {
  readonly kind: "reconciliation";
  readonly reconciliationId: string;
  readonly failureId: string;
  readonly resolution: GovernedRemediationReconciliationResolution;
  readonly ownerRevisionObserved: string | null;
}

export type GovernedRemediationReceipt =
  | GovernedRemediationApplicationReceipt
  | GovernedRemediationVerificationReceipt
  | GovernedRemediationRollbackReceipt
  | GovernedRemediationResumeReceipt
  | GovernedRemediationReconciliationReceipt;

export const GOVERNED_REMEDIATION_FAILURE_PHASES = [
  "classification",
  "offer",
  "preapproval",
  "secure_input",
  "preflight",
  "apply",
  "verify",
  "activation",
  "rollback",
  "resume",
  "recovery",
] as const;
export type GovernedRemediationFailurePhase = (typeof GOVERNED_REMEDIATION_FAILURE_PHASES)[number];

export const GOVERNED_REMEDIATION_FAILURE_REASONS = [
  "precondition_drift",
  "policy_denied",
  "approval_missing_or_expired",
  "prompt_expired",
  "secure_store_unavailable",
  "credential_rejected",
  "insufficient_scope",
  "rate_limited",
  "owner_unavailable",
  "invalid_candidate",
  "provenance_invalid",
  "owner_revision_conflict",
  "unsupported_profile",
  "unowned_target",
  "verification_failed",
  "rollback_failed",
  "resume_failed",
  "internal_error",
] as const;
export type GovernedRemediationFailureReason = (typeof GOVERNED_REMEDIATION_FAILURE_REASONS)[number];

export const GOVERNED_REMEDIATION_EFFECT_BOUNDARIES = ["not_crossed", "crossed", "unknown"] as const;
export type GovernedRemediationEffectBoundary = (typeof GOVERNED_REMEDIATION_EFFECT_BOUNDARIES)[number];

export const GOVERNED_REMEDIATION_FAILURE_DISPOSITIONS = [
  "retry_with_fresh_authority",
  "rollback_required",
  "manual_required",
  "terminal_no_effect",
] as const;
export type GovernedRemediationFailureDisposition = (typeof GOVERNED_REMEDIATION_FAILURE_DISPOSITIONS)[number];

/** Sanitized failure classification. Raw provider/owner errors are forbidden. */
export interface GovernedRemediationFailure {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION;
  readonly failureId: string;
  readonly remediationId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly scope: GovernedRemediationScope;
  readonly phase: GovernedRemediationFailurePhase;
  readonly reason: GovernedRemediationFailureReason;
  readonly effectBoundary: GovernedRemediationEffectBoundary;
  readonly disposition: GovernedRemediationFailureDisposition;
  readonly ownerRevisionObserved: string | null;
  readonly occurredAt: string;
}

export const GOVERNED_REMEDIATION_RECONCILIATION_REASONS = [
  "rollback_failed",
  "effect_state_unknown",
  "owner_revision_drift",
  "verification_receipt_missing",
  "resume_receipt_missing",
] as const;
export type GovernedRemediationReconciliationReason = (typeof GOVERNED_REMEDIATION_RECONCILIATION_REASONS)[number];

export const GOVERNED_REMEDIATION_RECONCILIATION_OBSERVATIONS = [
  "effect_absent",
  "effect_present_unverified",
  "effect_verified",
  "rolled_back",
  "unknown",
] as const;
export type GovernedRemediationReconciliationObservation =
  (typeof GOVERNED_REMEDIATION_RECONCILIATION_OBSERVATIONS)[number];

export const GOVERNED_REMEDIATION_RECONCILIATION_STATES = [
  "open",
  "quarantined",
  "resolved_no_effect",
  "resolved_rolled_back",
  "resolved_verified",
  "manual_required",
] as const;
export type GovernedRemediationReconciliationState = (typeof GOVERNED_REMEDIATION_RECONCILIATION_STATES)[number];

const GOVERNED_REMEDIATION_RECONCILIATION_TRANSITIONS: Readonly<
  Record<GovernedRemediationReconciliationState, readonly GovernedRemediationReconciliationState[]>
> = Object.freeze({
  open: Object.freeze<GovernedRemediationReconciliationState[]>([
    "quarantined",
    "resolved_no_effect",
    "resolved_rolled_back",
    "resolved_verified",
    "manual_required",
  ]),
  quarantined: Object.freeze<GovernedRemediationReconciliationState[]>([
    "resolved_no_effect",
    "resolved_rolled_back",
    "resolved_verified",
    "manual_required",
  ]),
  resolved_no_effect: Object.freeze<GovernedRemediationReconciliationState[]>([]),
  resolved_rolled_back: Object.freeze<GovernedRemediationReconciliationState[]>([]),
  resolved_verified: Object.freeze<GovernedRemediationReconciliationState[]>([]),
  manual_required: Object.freeze<GovernedRemediationReconciliationState[]>([]),
});

export function governedRemediationReconciliationCanTransition(
  from: GovernedRemediationReconciliationState,
  to: GovernedRemediationReconciliationState,
): boolean {
  return GOVERNED_REMEDIATION_RECONCILIATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Independent durable quarantine/recovery projection for uncertain effects. */
export interface GovernedRemediationReconciliation {
  readonly schemaVersion: typeof GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION;
  readonly reconciliationId: string;
  readonly remediationId: string;
  readonly failureId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly scope: GovernedRemediationScope;
  readonly reason: GovernedRemediationReconciliationReason;
  readonly observation: GovernedRemediationReconciliationObservation;
  readonly state: GovernedRemediationReconciliationState;
  readonly ownerRevisionObserved: string | null;
  readonly resolutionReceiptId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function normalizeGovernedRemediationScope(input: unknown): GovernedRemediationScope {
  const value = strictRecord(input, "scope", ["schemaVersion", "deploymentId", "scopeKind", "scopeId", "targetId"]);
  assertLiteral(value.schemaVersion, GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION, "scope schema version");
  const scopeKind = enumeration(value.scopeKind, GOVERNED_REMEDIATION_SCOPE_KINDS, "scope kind");
  return Object.freeze({
    schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
    deploymentId: identifier(value.deploymentId, "scope deployment ID"),
    scopeKind,
    scopeId: identifier(value.scopeId, "scope ID"),
    targetId: identifier(value.targetId, "scope target ID"),
  });
}

export function normalizeGovernedRemediationRecipe(input: unknown): GovernedRemediationRecipe {
  const value = strictRecord(input, "recipe", [
    "schemaVersion",
    "recipeId",
    "recipeVersion",
    "repairClass",
    "ownerId",
    "targetId",
    "requestedCapabilityId",
    "executionMode",
    "allowedScopeKinds",
    "allowedDeploymentProfiles",
    "inputKind",
    "preEffectApproval",
    "activationApproval",
    "verificationProbeId",
    "rollbackStrategy",
    "maxApplyAttempts",
  ]);
  assertLiteral(value.schemaVersion, GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION, "recipe schema version");
  const repairClass = enumeration(value.repairClass, GOVERNED_REMEDIATION_REPAIR_CLASSES, "repair class");
  const executionMode = enumeration(value.executionMode, GOVERNED_REMEDIATION_EXECUTION_MODES, "execution mode");
  const inputKind = enumeration(value.inputKind, GOVERNED_REMEDIATION_INPUT_KINDS, "input kind");
  const preEffectApproval = enumeration(
    value.preEffectApproval,
    GOVERNED_REMEDIATION_PRE_EFFECT_APPROVALS,
    "pre-effect approval",
  );
  const activationApproval = enumeration(
    value.activationApproval,
    GOVERNED_REMEDIATION_ACTIVATION_APPROVALS,
    "activation approval",
  );
  const rollbackStrategy = enumeration(
    value.rollbackStrategy,
    GOVERNED_REMEDIATION_ROLLBACK_STRATEGIES,
    "rollback strategy",
  );
  const allowedScopeKinds = sortedUniqueEnums(
    value.allowedScopeKinds,
    GOVERNED_REMEDIATION_SCOPE_KINDS,
    "allowed scope kinds",
  );
  const allowedDeploymentProfiles = sortedUniqueEnums(
    value.allowedDeploymentProfiles,
    ["local_dev", "trusted_local", "remote_hardened"] as const,
    "allowed deployment profiles",
  );
  if (allowedScopeKinds.length === 0 || allowedDeploymentProfiles.length === 0) {
    throw invalid("Recipe scope kinds and deployment profiles must both be non-empty.");
  }
  const verificationProbeId = nullableIdentifier(value.verificationProbeId, "verification probe ID");
  const maxApplyAttempts = integer(value.maxApplyAttempts, "max apply attempts", 0, 2) as 0 | 1 | 2;

  if (repairClass === "credential" && inputKind !== "secure_credential") {
    throw invalid("Credential recipes require the dedicated secure-credential input boundary.");
  }
  if (repairClass === "oauth_connection" && inputKind !== "oauth_redirect") {
    throw invalid("OAuth recipes require the dedicated redirect/token owner boundary.");
  }
  if (
    repairClass !== "credential" &&
    repairClass !== "oauth_connection" &&
    (inputKind === "secure_credential" || inputKind === "oauth_redirect")
  ) {
    throw invalid("Only credential and OAuth recipes may select a secret-bearing input protocol.");
  }
  if (
    (inputKind === "secure_credential" || inputKind === "oauth_redirect") &&
    preEffectApproval === "required_before_apply"
  ) {
    throw invalid("Secret-bearing input cannot wait for approval after collection.");
  }

  const genericManualClass =
    repairClass === "policy_auth_or_host_prerequisite" || repairClass === "product_source_or_binary";
  if (genericManualClass && executionMode !== "manual_required") {
    throw invalid("Policy/auth/host and product source/binary work is outside generic remediation authority.");
  }
  if (executionMode === "manual_required") {
    if (
      inputKind !== "none" ||
      preEffectApproval !== "not_applicable" ||
      activationApproval !== "not_applicable" ||
      verificationProbeId !== null ||
      rollbackStrategy !== "manual_required" ||
      maxApplyAttempts !== 0
    ) {
      throw invalid("Manual recipes cannot declare input, approval, probe, rollback, or apply authority.");
    }
  } else {
    if (preEffectApproval === "not_applicable" || activationApproval === "not_applicable") {
      throw invalid("Governed recipes must declare both approval postures explicitly.");
    }
    if (verificationProbeId === null || rollbackStrategy === "manual_required" || maxApplyAttempts < 1) {
      throw invalid("Governed recipes require a live probe, bounded rollback/safe-stop, and an apply attempt.");
    }
  }

  return Object.freeze({
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: identifier(value.recipeId, "recipe ID"),
    recipeVersion: integer(value.recipeVersion, "recipe version", 1),
    repairClass,
    ownerId: identifier(value.ownerId, "recipe owner ID"),
    targetId: identifier(value.targetId, "recipe target ID"),
    requestedCapabilityId: identifier(value.requestedCapabilityId, "requested capability ID"),
    executionMode,
    allowedScopeKinds: Object.freeze(allowedScopeKinds),
    allowedDeploymentProfiles: Object.freeze(allowedDeploymentProfiles),
    inputKind,
    preEffectApproval,
    activationApproval,
    verificationProbeId,
    rollbackStrategy,
    maxApplyAttempts,
  });
}

export function normalizeGovernedRemediationStateRecord(input: unknown): GovernedRemediationStateRecord {
  const value = strictRecord(input, "state record", [
    "schemaVersion",
    "remediationId",
    "workspaceId",
    "sessionId",
    "sourceTurnId",
    "durableRunId",
    "blockedCheckpointId",
    "recipeId",
    "recipeVersion",
    "scope",
    "state",
    "revision",
    "expectedWaitingRunVersion",
    "expectedOwnerRevision",
    "promptId",
    "promptExpiresAt",
    "approvalId",
    "effectId",
    "latestReceiptId",
    "failureId",
    "reconciliationId",
    "createdAt",
    "updatedAt",
  ]);
  assertLiteral(value.schemaVersion, GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION, "state schema version");
  const state = enumeration(value.state, GOVERNED_REMEDIATION_STATES, "state");
  const promptId = nullableIdentifier(value.promptId, "prompt ID");
  const promptExpiresAt = nullableTimestamp(value.promptExpiresAt, "prompt expiry");
  if ((promptId === null) !== (promptExpiresAt === null)) {
    throw invalid("Prompt ID and prompt expiry must be recorded together.");
  }
  if (state === "awaiting_secure_input" && promptId === null) {
    throw invalid("The awaiting_secure_input state requires an active prompt and expiry.");
  }
  const latestReceiptId = nullableIdentifier(value.latestReceiptId, "latest receipt ID");
  const failureId = nullableIdentifier(value.failureId, "failure ID");
  const reconciliationId = nullableIdentifier(value.reconciliationId, "reconciliation ID");
  if ((state === "failed" || state === "rollback_failed") && failureId === null) {
    throw invalid(`${state} requires a typed failure reference.`);
  }
  if (state === "rollback_failed" && reconciliationId === null) {
    throw invalid("rollback_failed requires a durable reconciliation reference.");
  }
  if ((state === "completed" || state === "rolled_back") && latestReceiptId === null) {
    throw invalid(`${state} requires a canonical receipt reference.`);
  }
  const createdAt = timestamp(value.createdAt, "created timestamp");
  const updatedAt = timestamp(value.updatedAt, "updated timestamp");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalid("State updated timestamp cannot precede its created timestamp.");
  }

  return Object.freeze({
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId: identifier(value.remediationId, "remediation ID"),
    workspaceId: identifier(value.workspaceId, "workspace ID"),
    sessionId: identifier(value.sessionId, "session ID"),
    sourceTurnId: identifier(value.sourceTurnId, "source turn ID"),
    durableRunId: identifier(value.durableRunId, "durable run ID"),
    blockedCheckpointId: identifier(value.blockedCheckpointId, "blocked checkpoint ID"),
    recipeId: identifier(value.recipeId, "state recipe ID"),
    recipeVersion: integer(value.recipeVersion, "state recipe version", 1),
    scope: normalizeGovernedRemediationScope(value.scope),
    state,
    revision: integer(value.revision, "state revision", 1),
    expectedWaitingRunVersion: integer(value.expectedWaitingRunVersion, "expected waiting-run version", 1),
    expectedOwnerRevision: nullableIdentifier(value.expectedOwnerRevision, "expected owner revision", 512),
    promptId,
    promptExpiresAt,
    approvalId: nullableIdentifier(value.approvalId, "approval ID"),
    effectId: nullableIdentifier(value.effectId, "effect ID"),
    latestReceiptId,
    failureId,
    reconciliationId,
    createdAt,
    updatedAt,
  });
}

export function normalizeGovernedRemediationReceipt(input: unknown): GovernedRemediationReceipt {
  const discriminator = strictRecordAtLeast(input, "receipt", ["kind"]);
  const kind = enumeration(discriminator.kind, GOVERNED_REMEDIATION_RECEIPT_KINDS, "receipt kind");
  const variantKeys: Record<GovernedRemediationReceiptKind, readonly string[]> = {
    application: ["ownerId", "effectId", "ownerRevisionBefore", "ownerRevisionAfter"],
    verification: ["applicationReceiptId", "probeId", "probeResult", "ownerRevisionObserved"],
    rollback: ["applicationReceiptId", "rollbackStrategy", "outcome", "ownerRevisionAfter"],
    resume: ["verificationReceiptId", "durableRunId", "blockedCheckpointId", "resumedRunVersion"],
    reconciliation: ["reconciliationId", "failureId", "resolution", "ownerRevisionObserved"],
  };
  const value = strictRecord(input, "receipt", [
    "schemaVersion",
    "receiptId",
    "remediationId",
    "recipeId",
    "recipeVersion",
    "scope",
    "kind",
    "recordedAt",
    ...variantKeys[kind],
  ]);
  const base = normalizeReceiptBase(value, kind);
  if (kind === "application") {
    return Object.freeze({
      ...base,
      kind,
      ownerId: identifier(value.ownerId, "application owner ID"),
      effectId: identifier(value.effectId, "application effect ID"),
      ownerRevisionBefore: nullableIdentifier(value.ownerRevisionBefore, "owner revision before", 512),
      ownerRevisionAfter: identifier(value.ownerRevisionAfter, "owner revision after", 512),
    });
  }
  if (kind === "verification") {
    assertLiteral(value.probeResult, "accepted", "verification probe result");
    return Object.freeze({
      ...base,
      kind,
      applicationReceiptId: identifier(value.applicationReceiptId, "application receipt ID"),
      probeId: identifier(value.probeId, "verification probe ID"),
      probeResult: "accepted",
      ownerRevisionObserved: identifier(value.ownerRevisionObserved, "verified owner revision", 512),
    });
  }
  if (kind === "rollback") {
    const rollbackStrategy = enumeration(
      value.rollbackStrategy,
      GOVERNED_REMEDIATION_ROLLBACK_STRATEGIES,
      "receipt rollback strategy",
    );
    if (rollbackStrategy === "manual_required") {
      throw invalid("A rollback receipt cannot claim a manual rollback as completed.");
    }
    assertLiteral(value.outcome, "rolled_back", "rollback outcome");
    return Object.freeze({
      ...base,
      kind,
      applicationReceiptId: identifier(value.applicationReceiptId, "application receipt ID"),
      rollbackStrategy,
      outcome: "rolled_back",
      ownerRevisionAfter: identifier(value.ownerRevisionAfter, "rollback owner revision", 512),
    });
  }
  if (kind === "resume") {
    return Object.freeze({
      ...base,
      kind,
      verificationReceiptId: identifier(value.verificationReceiptId, "verification receipt ID"),
      durableRunId: identifier(value.durableRunId, "receipt durable run ID"),
      blockedCheckpointId: identifier(value.blockedCheckpointId, "receipt blocked checkpoint ID"),
      resumedRunVersion: integer(value.resumedRunVersion, "resumed run version", 1),
    });
  }
  const resolution = enumeration(
    value.resolution,
    GOVERNED_REMEDIATION_RECONCILIATION_RESOLUTIONS,
    "reconciliation resolution",
  );
  return Object.freeze({
    ...base,
    kind,
    reconciliationId: identifier(value.reconciliationId, "receipt reconciliation ID"),
    failureId: identifier(value.failureId, "receipt failure ID"),
    resolution,
    ownerRevisionObserved: nullableIdentifier(value.ownerRevisionObserved, "reconciled owner revision", 512),
  });
}

export function normalizeGovernedRemediationFailure(input: unknown): GovernedRemediationFailure {
  const value = strictRecord(input, "failure", [
    "schemaVersion",
    "failureId",
    "remediationId",
    "recipeId",
    "recipeVersion",
    "scope",
    "phase",
    "reason",
    "effectBoundary",
    "disposition",
    "ownerRevisionObserved",
    "occurredAt",
  ]);
  assertLiteral(value.schemaVersion, GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION, "failure schema version");
  const phase = enumeration(value.phase, GOVERNED_REMEDIATION_FAILURE_PHASES, "failure phase");
  const reason = enumeration(value.reason, GOVERNED_REMEDIATION_FAILURE_REASONS, "failure reason");
  const effectBoundary = enumeration(
    value.effectBoundary,
    GOVERNED_REMEDIATION_EFFECT_BOUNDARIES,
    "failure effect boundary",
  );
  const disposition = enumeration(value.disposition, GOVERNED_REMEDIATION_FAILURE_DISPOSITIONS, "failure disposition");
  if (
    effectBoundary !== "not_crossed" &&
    (disposition === "retry_with_fresh_authority" || disposition === "terminal_no_effect")
  ) {
    throw invalid("A crossed or unknown effect boundary requires rollback or manual reconciliation.");
  }
  if (disposition === "rollback_required" && effectBoundary === "not_crossed") {
    throw invalid("Rollback cannot be required when the effect boundary was not crossed.");
  }
  if (reason === "rollback_failed" && (effectBoundary === "not_crossed" || disposition !== "manual_required")) {
    throw invalid("Rollback failure must retain crossed/unknown effect truth for manual reconciliation.");
  }
  if (
    (reason === "unsupported_profile" || reason === "unowned_target") &&
    (effectBoundary !== "not_crossed" || disposition !== "manual_required")
  ) {
    throw invalid("Unsupported profiles and unowned targets must stop before effects and require manual handling.");
  }
  return Object.freeze({
    schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
    failureId: identifier(value.failureId, "failure ID"),
    remediationId: identifier(value.remediationId, "failure remediation ID"),
    recipeId: identifier(value.recipeId, "failure recipe ID"),
    recipeVersion: integer(value.recipeVersion, "failure recipe version", 1),
    scope: normalizeGovernedRemediationScope(value.scope),
    phase,
    reason,
    effectBoundary,
    disposition,
    ownerRevisionObserved: nullableIdentifier(value.ownerRevisionObserved, "failure owner revision", 512),
    occurredAt: timestamp(value.occurredAt, "failure timestamp"),
  });
}

export function normalizeGovernedRemediationReconciliation(input: unknown): GovernedRemediationReconciliation {
  const value = strictRecord(input, "reconciliation", [
    "schemaVersion",
    "reconciliationId",
    "remediationId",
    "failureId",
    "recipeId",
    "recipeVersion",
    "scope",
    "reason",
    "observation",
    "state",
    "ownerRevisionObserved",
    "resolutionReceiptId",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  assertLiteral(
    value.schemaVersion,
    GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
    "reconciliation schema version",
  );
  const reason = enumeration(value.reason, GOVERNED_REMEDIATION_RECONCILIATION_REASONS, "reconciliation reason");
  const observation = enumeration(
    value.observation,
    GOVERNED_REMEDIATION_RECONCILIATION_OBSERVATIONS,
    "reconciliation observation",
  );
  const state = enumeration(value.state, GOVERNED_REMEDIATION_RECONCILIATION_STATES, "reconciliation state");
  const resolutionReceiptId = nullableIdentifier(value.resolutionReceiptId, "resolution receipt ID");
  if ((state === "open" || state === "quarantined" || state === "manual_required") && resolutionReceiptId !== null) {
    throw invalid(`${state} reconciliation cannot claim a resolution receipt.`);
  }
  if (state.startsWith("resolved_") && resolutionReceiptId === null) {
    throw invalid(`${state} reconciliation requires a canonical resolution receipt.`);
  }
  if (state === "resolved_no_effect" && observation !== "effect_absent") {
    throw invalid("resolved_no_effect requires an effect_absent owner observation.");
  }
  if (state === "resolved_rolled_back" && observation !== "rolled_back") {
    throw invalid("resolved_rolled_back requires a rolled_back owner observation.");
  }
  if (state === "resolved_verified" && observation !== "effect_verified") {
    throw invalid("resolved_verified requires an effect_verified owner observation.");
  }
  const createdAt = timestamp(value.createdAt, "reconciliation created timestamp");
  const updatedAt = timestamp(value.updatedAt, "reconciliation updated timestamp");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalid("Reconciliation updated timestamp cannot precede its created timestamp.");
  }
  return Object.freeze({
    schemaVersion: GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
    reconciliationId: identifier(value.reconciliationId, "reconciliation ID"),
    remediationId: identifier(value.remediationId, "reconciliation remediation ID"),
    failureId: identifier(value.failureId, "reconciliation failure ID"),
    recipeId: identifier(value.recipeId, "reconciliation recipe ID"),
    recipeVersion: integer(value.recipeVersion, "reconciliation recipe version", 1),
    scope: normalizeGovernedRemediationScope(value.scope),
    reason,
    observation,
    state,
    ownerRevisionObserved: nullableIdentifier(value.ownerRevisionObserved, "reconciliation owner revision", 512),
    resolutionReceiptId,
    revision: integer(value.revision, "reconciliation revision", 1),
    createdAt,
    updatedAt,
  });
}

function normalizeReceiptBase(
  value: Record<string, unknown>,
  kind: GovernedRemediationReceiptKind,
): GovernedRemediationReceiptBase {
  assertLiteral(value.schemaVersion, GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION, "receipt schema version");
  return {
    schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
    receiptId: identifier(value.receiptId, "receipt ID"),
    remediationId: identifier(value.remediationId, "receipt remediation ID"),
    recipeId: identifier(value.recipeId, "receipt recipe ID"),
    recipeVersion: integer(value.recipeVersion, "receipt recipe version", 1),
    scope: normalizeGovernedRemediationScope(value.scope),
    kind,
    recordedAt: timestamp(value.recordedAt, "receipt timestamp"),
  };
}

function strictRecord(input: unknown, field: string, exactKeys: readonly string[]): Record<string, unknown> {
  const value = strictRecordAtLeast(input, field, exactKeys);
  if (Object.keys(value).length !== exactKeys.length) {
    throw invalid(`${field} contains unsupported fields.`);
  }
  return value;
}

function strictRecordAtLeast(input: unknown, field: string, requiredKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${field} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw invalid(`${field} cannot carry symbol fields.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw invalid(`${field} must contain only plain data fields.`);
    }
  }
  const value = input as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw invalid(`${field} is missing required field ${key}.`);
    }
  }
  return value;
}

function identifier(value: unknown, field: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value)
  ) {
    throw invalid(`${field} must be a bounded canonical identifier.`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string, maxLength = 256): string | null {
  return value === null ? null : identifier(value, field, maxLength);
}

function integer(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalid(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw invalid(`${field} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`${field} is unsupported.`);
  }
  return value as T;
}

function sortedUniqueEnums<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw invalid(`${field} must be a bounded array.`);
  }
  const normalized = value.map((entry) => enumeration(entry, allowed, field));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid(`${field} cannot contain duplicates.`);
  }
  return normalized.sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
}

function assertLiteral<T extends string>(value: unknown, expected: T, field: string): asserts value is T {
  if (value !== expected) throw invalid(`${field} is unsupported.`);
}

function invalid(message: string): TypeError {
  return new TypeError(`Governed remediation ${message}`);
}
