import {
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
  readonly recipe: GovernedRemediationRecipe;
  readonly scope: GovernedRemediationScope;
  readonly effectId: string;
  readonly operationId: string;
  readonly expectedOwnerRevision: string | null;
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
    }
  | {
      readonly observation: "rolled_back";
      readonly application: GovernedRemediationReconciledApplication;
      readonly ownerRevisionAfter: string;
    }
  | {
      readonly observation: "unknown";
      readonly ownerRevisionObserved: string | null;
    };

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
  /** Every effectful method must replay exactly by operationId and effectId. */
  preflight(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationPreflightResult>;
  apply(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult>;
  probe(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationProbeResult>;
  activate(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationActivationResult>;
  rollback(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationRollbackResult>;
  reconcile(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationReconcileResult>;
}

export interface GovernedRemediationRecipeRegistration {
  readonly recipe: GovernedRemediationRecipe;
  /** Manual-only recipes have no callable runtime owner. */
  readonly owner: GovernedRemediationOwnerPort | null;
}

export interface GovernedRemediationRecipeResolution {
  readonly recipe: GovernedRemediationRecipe;
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
  | "governed_recipe_missing_owner"
  | "activation_mismatch";

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
      byExactKey.set(exactKey, Object.freeze({ recipe, owner: registration.owner }));
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
    owner.requestedCapabilityId !== recipe.requestedCapabilityId
  ) {
    throw registryError("invalid_owner_binding", "Governed remediation owner binding does not match its recipe.");
  }
  if (owner.activationMode === "not_applicable" && recipe.activationApproval === "required") {
    throw registryError(
      "activation_mismatch",
      "A recipe cannot require activation approval when its owner has no activation step.",
    );
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
