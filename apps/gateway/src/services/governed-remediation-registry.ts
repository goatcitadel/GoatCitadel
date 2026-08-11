import {
  canonicalJsonString,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationFailureReason,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";

/**
 * This registry is the callable allowlist. A contract-shaped recipe is not
 * executable unless this exact recipe/version/target/capability binding is
 * registered with its runtime owner.
 */

export type GovernedRemediationOwnerFailureReason = Extract<
  GovernedRemediationFailureReason,
  | "precondition_drift"
  | "policy_denied"
  | "approval_missing_or_expired"
  | "prompt_expired"
  | "secure_store_unavailable"
  | "credential_rejected"
  | "insufficient_scope"
  | "rate_limited"
  | "owner_unavailable"
  | "invalid_candidate"
  | "provenance_invalid"
  | "owner_revision_conflict"
  | "verification_failed"
  | "internal_error"
>;

export interface GovernedRemediationOwnerContext {
  readonly remediationId: string;
  readonly requesterActorId: string;
  readonly workspaceId: string;
  readonly stateRevision: number;
  readonly recipe: GovernedRemediationRecipe;
  readonly recipeSha256: string;
  readonly scope: GovernedRemediationScope;
  readonly effectId: string;
  readonly operationId: string;
  readonly expectedOwnerRevision: string | null;
  readonly parentReservationId: string | null;
  readonly approvalPurpose: "pre_effect" | "activation" | null;
  readonly approvalId: string | null;
  readonly promptId: string | null;
}

export type GovernedRemediationPreflightResult =
  | {
      readonly status: "ready";
      readonly ownerRevision: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    };

export type GovernedRemediationApplyResult =
  | {
      readonly status: "applied";
      readonly effectId: string;
      readonly ownerRevisionBefore: string | null;
      readonly ownerRevisionAfter: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    }
  | {
      /** The owner cannot prove whether the effect boundary was crossed. */
      readonly status: "uncertain";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    };

export type GovernedRemediationProbeResult =
  | {
      readonly status: "accepted";
      readonly probeId: string;
      readonly ownerRevisionObserved: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    };

export type GovernedRemediationActivationResult =
  | {
      readonly status: "activated";
      readonly ownerRevisionBefore: string;
      readonly ownerRevisionAfter: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    }
  | {
      readonly status: "uncertain";
      readonly reason: GovernedRemediationOwnerFailureReason;
      readonly ownerRevisionObserved: string | null;
    };

export type GovernedRemediationRollbackResult =
  | {
      readonly status: "rolled_back";
      readonly ownerRevisionBefore: string;
      readonly ownerRevisionAfter: string;
    }
  | {
      readonly status: "failed";
      readonly ownerRevisionObserved: string | null;
      readonly effectState: "present" | "unknown";
    };

export interface GovernedRemediationReconciledApplication {
  readonly effectId: string;
  readonly ownerRevisionBefore: string | null;
  readonly ownerRevisionAfter: string;
}

export type GovernedRemediationReconcileResult =
  | {
      readonly observation: "effect_absent";
      readonly ownerRevisionObserved: string | null;
    }
  | {
      readonly observation: "effect_present_unverified" | "effect_verified";
      readonly application: GovernedRemediationReconciledApplication;
      readonly ownerRevisionObserved: string;
    }
  | {
      readonly observation: "rolled_back";
      readonly application: GovernedRemediationReconciledApplication;
      readonly ownerRevisionBefore: string;
      readonly ownerRevisionAfter: string;
    }
  | {
      readonly observation: "unknown";
      readonly ownerRevisionObserved: string | null;
    };

const OWNER_FAILURE_REASONS = new Set<GovernedRemediationOwnerFailureReason>([
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
  "verification_failed",
  "internal_error",
]);

const SECRET_LIKE_OWNER_VALUE =
  /(?:(?:api[_-]?key|auth(?:orization)?|cookie|credential|password|secret|token)\s*[:=]\s*["']?[a-z0-9._\/-]{8,}|\bbearer\s+[a-z0-9._~+\/-]{12,}|\bsk-[a-z0-9_-]{16,}|\bghp_[a-z0-9_]{16,}|\bxox[baprs]-[a-z0-9-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

/**
 * Owner ports are runtime trust boundaries, not TypeScript-only interfaces.
 * These exact normalizers reject extra/raw fields and secret-like identifiers
 * before any owner result can reach durable storage.
 */
export function normalizeGovernedRemediationPreflightResult(input: unknown): GovernedRemediationPreflightResult {
  const discriminator = ownerRecord(input, "preflight result");
  if (discriminator.status === "ready") {
    const value = exactOwnerRecord(input, "ready preflight result", ["status", "ownerRevision"]);
    return Object.freeze({ status: "ready", ownerRevision: ownerRevision(value.ownerRevision, "preflight revision") });
  }
  if (discriminator.status === "rejected") {
    const value = exactOwnerRecord(input, "rejected preflight result", ["status", "reason", "ownerRevisionObserved"]);
    return Object.freeze({
      status: "rejected",
      reason: ownerFailureReason(value.reason),
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "preflight observed revision"),
    });
  }
  throw new TypeError("Governed remediation preflight result has an unsupported status.");
}

export function normalizeGovernedRemediationApplyResult(input: unknown): GovernedRemediationApplyResult {
  const discriminator = ownerRecord(input, "apply result");
  if (discriminator.status === "applied") {
    const value = exactOwnerRecord(input, "applied result", [
      "status",
      "effectId",
      "ownerRevisionBefore",
      "ownerRevisionAfter",
    ]);
    return Object.freeze({
      status: "applied",
      effectId: ownerIdentifier(value.effectId, "apply effect ID"),
      ownerRevisionBefore: nullableOwnerRevision(value.ownerRevisionBefore, "apply revision before"),
      ownerRevisionAfter: ownerRevision(value.ownerRevisionAfter, "apply revision after"),
    });
  }
  if (discriminator.status === "rejected" || discriminator.status === "uncertain") {
    const value = exactOwnerRecord(input, `${discriminator.status} apply result`, [
      "status",
      "reason",
      "ownerRevisionObserved",
    ]);
    return Object.freeze({
      status: discriminator.status,
      reason: ownerFailureReason(value.reason),
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "apply observed revision"),
    });
  }
  throw new TypeError("Governed remediation apply result has an unsupported status.");
}

export function normalizeGovernedRemediationProbeResult(input: unknown): GovernedRemediationProbeResult {
  const discriminator = ownerRecord(input, "probe result");
  if (discriminator.status === "accepted") {
    const value = exactOwnerRecord(input, "accepted probe result", ["status", "probeId", "ownerRevisionObserved"]);
    return Object.freeze({
      status: "accepted",
      probeId: ownerIdentifier(value.probeId, "probe ID"),
      ownerRevisionObserved: ownerRevision(value.ownerRevisionObserved, "probe observed revision"),
    });
  }
  if (discriminator.status === "rejected") {
    const value = exactOwnerRecord(input, "rejected probe result", ["status", "reason", "ownerRevisionObserved"]);
    return Object.freeze({
      status: "rejected",
      reason: ownerFailureReason(value.reason),
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "probe observed revision"),
    });
  }
  throw new TypeError("Governed remediation probe result has an unsupported status.");
}

export function normalizeGovernedRemediationActivationResult(input: unknown): GovernedRemediationActivationResult {
  const discriminator = ownerRecord(input, "activation result");
  if (discriminator.status === "activated") {
    const value = exactOwnerRecord(input, "activated result", ["status", "ownerRevisionBefore", "ownerRevisionAfter"]);
    return Object.freeze({
      status: "activated",
      ownerRevisionBefore: ownerRevision(value.ownerRevisionBefore, "activation revision before"),
      ownerRevisionAfter: ownerRevision(value.ownerRevisionAfter, "activation revision after"),
    });
  }
  if (discriminator.status === "rejected" || discriminator.status === "uncertain") {
    const value = exactOwnerRecord(input, `${discriminator.status} activation result`, [
      "status",
      "reason",
      "ownerRevisionObserved",
    ]);
    return Object.freeze({
      status: discriminator.status,
      reason: ownerFailureReason(value.reason),
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "activation observed revision"),
    });
  }
  throw new TypeError("Governed remediation activation result has an unsupported status.");
}

export function normalizeGovernedRemediationRollbackResult(input: unknown): GovernedRemediationRollbackResult {
  const discriminator = ownerRecord(input, "rollback result");
  if (discriminator.status === "rolled_back") {
    const value = exactOwnerRecord(input, "rolled-back result", [
      "status",
      "ownerRevisionBefore",
      "ownerRevisionAfter",
    ]);
    return Object.freeze({
      status: "rolled_back",
      ownerRevisionBefore: ownerRevision(value.ownerRevisionBefore, "rollback revision before"),
      ownerRevisionAfter: ownerRevision(value.ownerRevisionAfter, "rollback revision after"),
    });
  }
  if (discriminator.status === "failed") {
    const value = exactOwnerRecord(input, "failed rollback result", ["status", "ownerRevisionObserved", "effectState"]);
    if (value.effectState !== "present" && value.effectState !== "unknown") {
      throw new TypeError("Governed remediation rollback effect state is unsupported.");
    }
    return Object.freeze({
      status: "failed",
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "rollback observed revision"),
      effectState: value.effectState,
    });
  }
  throw new TypeError("Governed remediation rollback result has an unsupported status.");
}

export function normalizeGovernedRemediationReconcileResult(input: unknown): GovernedRemediationReconcileResult {
  const discriminator = ownerRecord(input, "reconcile result");
  if (discriminator.observation === "effect_absent" || discriminator.observation === "unknown") {
    const value = exactOwnerRecord(input, `${discriminator.observation} reconciliation result`, [
      "observation",
      "ownerRevisionObserved",
    ]);
    return Object.freeze({
      observation: discriminator.observation,
      ownerRevisionObserved: nullableOwnerRevision(value.ownerRevisionObserved, "reconciliation observed revision"),
    });
  }
  if (discriminator.observation === "effect_present_unverified" || discriminator.observation === "effect_verified") {
    const value = exactOwnerRecord(input, `${discriminator.observation} reconciliation result`, [
      "observation",
      "application",
      "ownerRevisionObserved",
    ]);
    return Object.freeze({
      observation: discriminator.observation,
      application: normalizeReconciledApplication(value.application),
      ownerRevisionObserved: ownerRevision(value.ownerRevisionObserved, "reconciliation observed revision"),
    });
  }
  if (discriminator.observation === "rolled_back") {
    const value = exactOwnerRecord(input, "rolled-back reconciliation result", [
      "observation",
      "application",
      "ownerRevisionBefore",
      "ownerRevisionAfter",
    ]);
    return Object.freeze({
      observation: "rolled_back",
      application: normalizeReconciledApplication(value.application),
      ownerRevisionBefore: ownerRevision(value.ownerRevisionBefore, "reconciled rollback revision before"),
      ownerRevisionAfter: ownerRevision(value.ownerRevisionAfter, "reconciled rollback revision after"),
    });
  }
  throw new TypeError("Governed remediation reconcile result has an unsupported observation.");
}

/**
 * Owner implementations receive only canonical identifiers and authority
 * references. Secret values, OAuth redirects, arbitrary arguments, commands,
 * and raw owner errors are intentionally absent from this boundary.
 */
export interface GovernedRemediationOwnerPort {
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly activationMode: "not_applicable" | "owner_step";
  /** Observation methods must not mutate owner state. */
  preflight(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationPreflightResult>;
  /** Effect methods must serialize and replay exactly by operationId and effectId. */
  apply(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult>;
  /** Observation methods must not mutate owner state. */
  probe(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationProbeResult>;
  /** Effect methods must serialize and replay exactly by operationId and effectId. */
  activate(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationActivationResult>;
  /** Effect methods must serialize and replay exactly by operationId and effectId. */
  rollback(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationRollbackResult>;
  /** Observation methods must not mutate owner state. */
  reconcile(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationReconcileResult>;
}

export interface GovernedRemediationRecipeRegistration {
  readonly recipe: GovernedRemediationRecipe;
  /** Manual-only recipes have no callable runtime owner. */
  readonly owner: GovernedRemediationOwnerPort | null;
}

export interface GovernedRemediationRecipeResolution {
  readonly recipe: GovernedRemediationRecipe;
  readonly recipeSha256: string;
  readonly owner: GovernedRemediationOwnerPort | null;
}

export type GovernedRemediationRegistryErrorCode =
  | "duplicate_binding"
  | "conflicting_binding"
  | "invalid_owner_binding"
  | "recipe_not_allowlisted"
  | "profile_not_allowlisted"
  | "scope_not_allowlisted"
  | "target_mismatch"
  | "capability_mismatch"
  | "manual_recipe_has_owner"
  | "governed_recipe_missing_owner";

export class GovernedRemediationRegistryError extends Error {
  public constructor(
    public readonly code: GovernedRemediationRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GovernedRemediationRegistryError";
  }
}

export interface ResolveGovernedRemediationRecipeInput {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
}

export interface ResolveStoredGovernedRemediationRecipeInput {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
}

export class GovernedRemediationRecipeRegistry {
  private readonly byExactKey: ReadonlyMap<string, GovernedRemediationRecipeResolution>;
  private readonly exactKeyByVersion: ReadonlyMap<string, string>;

  public constructor(registrations: readonly GovernedRemediationRecipeRegistration[]) {
    const byExactKey = new Map<string, GovernedRemediationRecipeResolution>();
    const exactKeyByVersion = new Map<string, string>();
    for (const registration of registrations) {
      const recipe = normalizeGovernedRemediationRecipe(registration.recipe);
      validateRegistration(recipe, registration.owner);
      const exactKey = recipeExactKey(recipe);
      const versionKey = recipeVersionKey(recipe.recipeId, recipe.recipeVersion);
      if (byExactKey.has(exactKey)) {
        throw registryError("duplicate_binding", `Duplicate governed remediation binding ${exactKey}.`);
      }
      const priorExactKey = exactKeyByVersion.get(versionKey);
      if (priorExactKey && priorExactKey !== exactKey) {
        throw registryError(
          "conflicting_binding",
          `Governed remediation recipe ${versionKey} has conflicting target or capability bindings.`,
        );
      }
      byExactKey.set(
        exactKey,
        Object.freeze({
          recipe,
          recipeSha256: governedRemediationRecipeSha256(recipe),
          owner: registration.owner,
        }),
      );
      exactKeyByVersion.set(versionKey, exactKey);
    }
    this.byExactKey = byExactKey;
    this.exactKeyByVersion = exactKeyByVersion;
    Object.freeze(this);
  }

  public resolve(input: ResolveGovernedRemediationRecipeInput): GovernedRemediationRecipeResolution {
    const scope = normalizeGovernedRemediationScope(input.scope);
    const versionKey = recipeVersionKey(input.recipeId, input.recipeVersion);
    const registeredExactKey = this.exactKeyByVersion.get(versionKey);
    if (!registeredExactKey) {
      throw registryError("recipe_not_allowlisted", `Governed remediation recipe ${versionKey} is not allowlisted.`);
    }
    const expectedExactKey = exactKey(input.recipeId, input.recipeVersion, input.targetId, input.requestedCapabilityId);
    const resolution = this.byExactKey.get(expectedExactKey);
    if (!resolution) {
      const registered = this.byExactKey.get(registeredExactKey)!;
      if (registered.recipe.targetId !== input.targetId) {
        throw registryError("target_mismatch", "Governed remediation target does not match its allowlisted recipe.");
      }
      throw registryError(
        "capability_mismatch",
        "Governed remediation capability does not match its allowlisted recipe.",
      );
    }
    if (scope.targetId !== resolution.recipe.targetId) {
      throw registryError("target_mismatch", "Governed remediation scope target does not match its recipe target.");
    }
    if (!resolution.recipe.allowedScopeKinds.includes(scope.scopeKind)) {
      throw registryError("scope_not_allowlisted", "Governed remediation scope kind is not allowlisted by the recipe.");
    }
    if (!resolution.recipe.allowedDeploymentProfiles.includes(input.deploymentProfile)) {
      throw registryError(
        "profile_not_allowlisted",
        "Governed remediation deployment profile is not allowlisted by the recipe.",
      );
    }
    // Owners may be stateful and therefore are not frozen. Re-check their
    // binding fields so mutation cannot silently change the callable allowlist.
    validateRegistration(resolution.recipe, resolution.owner);
    return resolution;
  }

  /** Exact recovery lookup; target/capability still come from the immutable binding. */
  public resolveStored(input: ResolveStoredGovernedRemediationRecipeInput): GovernedRemediationRecipeResolution {
    const versionKey = recipeVersionKey(input.recipeId, input.recipeVersion);
    const registeredExactKey = this.exactKeyByVersion.get(versionKey);
    const registered = registeredExactKey ? this.byExactKey.get(registeredExactKey) : undefined;
    if (!registered) {
      throw registryError("recipe_not_allowlisted", `Governed remediation recipe ${versionKey} is not allowlisted.`);
    }
    return this.resolve({
      ...input,
      targetId: registered.recipe.targetId,
      requestedCapabilityId: registered.recipe.requestedCapabilityId,
    });
  }
}

function validateRegistration(recipe: GovernedRemediationRecipe, owner: GovernedRemediationOwnerPort | null): void {
  if (recipe.executionMode === "manual_required") {
    if (owner !== null) {
      throw registryError("manual_recipe_has_owner", "Manual remediation recipes cannot have callable owners.");
    }
    return;
  }
  if (!owner) {
    throw registryError("governed_recipe_missing_owner", "Governed remediation recipes require an exact owner.");
  }
  if (
    owner.ownerId !== recipe.ownerId ||
    owner.targetId !== recipe.targetId ||
    owner.requestedCapabilityId !== recipe.requestedCapabilityId ||
    owner.activationMode !== recipe.activationMode
  ) {
    throw registryError("invalid_owner_binding", "Governed remediation owner binding does not match its recipe.");
  }
}

function recipeExactKey(recipe: GovernedRemediationRecipe): string {
  return exactKey(recipe.recipeId, recipe.recipeVersion, recipe.targetId, recipe.requestedCapabilityId);
}

function exactKey(recipeId: string, recipeVersion: number, targetId: string, capabilityId: string): string {
  return `${recipeVersionKey(recipeId, recipeVersion)}|${targetId}|${capabilityId}`;
}

function recipeVersionKey(recipeId: string, recipeVersion: number): string {
  return `${recipeId}@${recipeVersion}`;
}

function registryError(code: GovernedRemediationRegistryErrorCode, message: string): GovernedRemediationRegistryError {
  return new GovernedRemediationRegistryError(code, message);
}

function normalizeReconciledApplication(input: unknown): GovernedRemediationReconciledApplication {
  const value = exactOwnerRecord(input, "reconciled application", [
    "effectId",
    "ownerRevisionBefore",
    "ownerRevisionAfter",
  ]);
  return Object.freeze({
    effectId: ownerIdentifier(value.effectId, "reconciled effect ID"),
    ownerRevisionBefore: nullableOwnerRevision(value.ownerRevisionBefore, "reconciled revision before"),
    ownerRevisionAfter: ownerRevision(value.ownerRevisionAfter, "reconciled revision after"),
  });
}

function ownerRecord(input: unknown, label: string): Record<string, unknown> {
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

function exactOwnerRecord(input: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const value = ownerRecord(input, label);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`Governed remediation ${label} has an invalid key set.`);
  }
  const actualKeys = Object.getOwnPropertyNames(value).sort();
  const expectedKeys = [...keys].sort();
  if (canonicalJsonString(actualKeys) !== canonicalJsonString(expectedKeys)) {
    throw new TypeError(`Governed remediation ${label} has an invalid key set.`);
  }
  return value;
}

function ownerFailureReason(value: unknown): GovernedRemediationOwnerFailureReason {
  if (typeof value !== "string" || !OWNER_FAILURE_REASONS.has(value as GovernedRemediationOwnerFailureReason)) {
    throw new TypeError("Governed remediation owner returned an unsupported failure reason.");
  }
  return value as GovernedRemediationOwnerFailureReason;
}

function ownerIdentifier(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    SECRET_LIKE_OWNER_VALUE.test(value)
  ) {
    throw new TypeError(`Governed remediation ${label} is not a canonical secret-free identifier.`);
  }
  return value;
}

function ownerRevision(value: unknown, label: string): string {
  return ownerIdentifier(value, label, 512);
}

function nullableOwnerRevision(value: unknown, label: string): string | null {
  return value === null ? null : ownerRevision(value, label);
}
