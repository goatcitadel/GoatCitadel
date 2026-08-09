import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  ValidationError,
  canonicalJsonString,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationRecipeRegistration,
} from "./governed-remediation-registry.js";
import {
  ConfigGenerationService,
  assertValidCompleteUnifiedConfig,
  type CompleteUnifiedConfigPayload,
} from "./config-generation-service.js";

const CONFIG_REPAIR_TARGET_ID = "gateway.config.canonical-generation";
const CONFIG_REPAIR_CAPABILITY_ID = "runtime.configuration.valid";
const CONFIG_REPAIR_OWNER_ID = "gateway.config-generation";
const CONFIG_REPAIR_SECTIONS = ["assistant", "toolPolicy", "budgets", "llm", "cronJobs"] as const;
const CONFIG_GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONFIG_OWNER_REVISION =
  /^config-generation:v1:[1-9][0-9]{0,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE: GovernedRemediationRecipe =
  normalizeGovernedRemediationRecipe({
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "gateway.config.canonical-generation.manual-repair",
    recipeVersion: 1,
    repairClass: "declarative_configuration",
    ownerId: CONFIG_REPAIR_OWNER_ID,
    targetId: CONFIG_REPAIR_TARGET_ID,
    requestedCapabilityId: CONFIG_REPAIR_CAPABILITY_ID,
    executionMode: "manual_required",
    allowedScopeKinds: ["installation"],
    allowedDeploymentProfiles: ["local_dev", "remote_hardened", "trusted_local"],
    inputKind: "none",
    preEffectApproval: "not_applicable",
    activationMode: "not_applicable",
    activationApproval: "not_applicable",
    verificationProbeId: null,
    rollbackStrategy: "manual_required",
    maxApplyAttempts: 0,
  });

export const GOVERNED_CONFIG_MANUAL_REPAIR_REGISTRATION: GovernedRemediationRecipeRegistration = Object.freeze({
  recipe: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE,
  owner: null,
});

const MANUAL_CONFIG_REGISTRY = new GovernedRemediationRecipeRegistry([
  GOVERNED_CONFIG_MANUAL_REPAIR_REGISTRATION,
]);

export const GOVERNED_CONFIG_REPAIR_DIFF_SCHEMA_VERSION =
  "goatcitadel.governed-remediation-config-diff.v1" as const;

export interface GovernedConfigRepairSanitizedDiff {
  readonly schemaVersion: typeof GOVERNED_CONFIG_REPAIR_DIFF_SCHEMA_VERSION;
  readonly candidateValidation: "valid" | "invalid" | "unavailable";
  /** Fixed section names only. Candidate keys and values never cross this boundary. */
  readonly changedSections: readonly (typeof CONFIG_REPAIR_SECTIONS)[number][];
  readonly semanticChange: boolean | null;
}

export type GovernedConfigRepairManualReason =
  | "candidate_unavailable"
  | "candidate_invalid"
  | "exact_owner_revision_unavailable"
  | "owner_reconciliation_pending"
  | "owner_revision_conflict"
  | "durable_effect_journal_unavailable";

interface GovernedConfigRepairAssessmentBase {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  readonly ownerRevision: string | null;
  readonly diff: GovernedConfigRepairSanitizedDiff;
  readonly automaticExecution: false;
}

export type GovernedConfigRepairAssessment =
  | (GovernedConfigRepairAssessmentBase & {
      readonly status: "not_required";
    })
  | (GovernedConfigRepairAssessmentBase & {
      readonly status: "manual_required";
      readonly reason: GovernedConfigRepairManualReason;
    });

export interface AssessGovernedConfigRepairInput {
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
  /** Null means the caller could not capture an exact, secret-free revision. */
  readonly expectedOwnerRevision: string | null;
  /** A complete candidate from a trusted config owner, never a model-authored patch. */
  readonly candidate?: unknown;
}

/**
 * Read-only bridge from the canonical configuration owner to governed
 * remediation classification.
 *
 * ConfigGenerationService provides config CAS and same-call compensation, but
 * it does not retain a per-remediation pre-effect payload or operation/effect
 * marker after a successful commit. RuntimeConfigurationService likewise keeps
 * credential compensation material only in process memory. Therefore this
 * adapter intentionally registers no callable owner: claiming apply, rollback,
 * or restart reconciliation here would be unable to prove effect ownership in
 * the crash window before the remediation receipt is published.
 */
export class GovernedRemediationConfigRepairAdapter {
  public constructor(private readonly configGeneration: ConfigGenerationService) {}

  public getOwnerRevision(): string | null {
    return currentSecretFreeOwnerRevision(this.configGeneration);
  }

  public assess(input: AssessGovernedConfigRepairInput): GovernedConfigRepairAssessment {
    const scope = normalizeGovernedRemediationScope(input.scope);
    const resolution = MANUAL_CONFIG_REGISTRY.resolve({
      recipeId: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.recipeId,
      recipeVersion: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.recipeVersion,
      targetId: CONFIG_REPAIR_TARGET_ID,
      requestedCapabilityId: CONFIG_REPAIR_CAPABILITY_ID,
      deploymentProfile: input.deploymentProfile,
      scope,
    });
    const ownerRevision = currentSecretFreeOwnerRevision(this.configGeneration);
    const diff = sanitizedConfigDiff(this.configGeneration.getActivePayload(), input.candidate);
    const base = Object.freeze({
      recipeId: resolution.recipe.recipeId,
      recipeVersion: resolution.recipe.recipeVersion,
      recipeSha256: resolution.recipeSha256,
      ownerId: resolution.recipe.ownerId,
      targetId: resolution.recipe.targetId,
      requestedCapabilityId: resolution.recipe.requestedCapabilityId,
      scope,
      ownerRevision,
      diff,
      automaticExecution: false as const,
    });

    if (diff.candidateValidation === "unavailable") {
      return Object.freeze({ ...base, status: "manual_required", reason: "candidate_unavailable" });
    }
    if (diff.candidateValidation === "invalid") {
      return Object.freeze({ ...base, status: "manual_required", reason: "candidate_invalid" });
    }
    if (ownerRevision === null) {
      return Object.freeze({ ...base, status: "manual_required", reason: "exact_owner_revision_unavailable" });
    }
    if (!isCanonicalOwnerRevision(input.expectedOwnerRevision)) {
      return Object.freeze({ ...base, status: "manual_required", reason: "owner_revision_conflict" });
    }
    if (input.expectedOwnerRevision !== ownerRevision) {
      return Object.freeze({ ...base, status: "manual_required", reason: "owner_revision_conflict" });
    }
    if (this.configGeneration.getHealthSnapshot().transactionState !== "idle") {
      return Object.freeze({ ...base, status: "manual_required", reason: "owner_reconciliation_pending" });
    }
    if (diff.semanticChange === false) {
      return Object.freeze({ ...base, status: "not_required" });
    }
    return Object.freeze({
      ...base,
      status: "manual_required",
      reason: "durable_effect_journal_unavailable",
    });
  }
}

export function governedConfigRepairScope(input: {
  deploymentId: string;
  installationId: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: "goatcitadel.governed-remediation-scope.v1",
    deploymentId: input.deploymentId,
    scopeKind: "installation",
    scopeId: input.installationId,
    targetId: CONFIG_REPAIR_TARGET_ID,
  });
}

export function governedConfigRepairRecipeSha256(): string {
  return governedRemediationRecipeSha256(GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE);
}

function currentSecretFreeOwnerRevision(configGeneration: ConfigGenerationService): string | null {
  const active = configGeneration.getActivePayload();
  const generation = active.generation;
  if (!generation || !CONFIG_GENERATION_ID.test(generation.generationId)) return null;
  return `config-generation:v1:${generation.revision}:${generation.generationId}`;
}

function isCanonicalOwnerRevision(value: string | null): value is string {
  if (value === null) return false;
  if (!CONFIG_OWNER_REVISION.test(value)) {
    throw new ValidationError({ message: "Expected config owner revision is not canonical and secret-free." });
  }
  return true;
}

function sanitizedConfigDiff(
  active: CompleteUnifiedConfigPayload,
  rawCandidate: unknown,
): GovernedConfigRepairSanitizedDiff {
  if (rawCandidate === undefined) {
    return Object.freeze({
      schemaVersion: GOVERNED_CONFIG_REPAIR_DIFF_SCHEMA_VERSION,
      candidateValidation: "unavailable",
      changedSections: Object.freeze([]),
      semanticChange: null,
    });
  }
  try {
    const candidate = structuredClone(rawCandidate);
    assertValidCompleteUnifiedConfig(candidate, "governed remediation config candidate");
    const changedSections = CONFIG_REPAIR_SECTIONS.filter(
      (section) => canonicalJsonString(active[section]) !== canonicalJsonString(candidate[section]),
    );
    return Object.freeze({
      schemaVersion: GOVERNED_CONFIG_REPAIR_DIFF_SCHEMA_VERSION,
      candidateValidation: "valid",
      changedSections: Object.freeze(changedSections),
      semanticChange: changedSections.length > 0,
    });
  } catch {
    // Candidate values, paths, validation details, and hashes are deliberately
    // excluded because config payloads may still contain legacy inline secrets.
    return Object.freeze({
      schemaVersion: GOVERNED_CONFIG_REPAIR_DIFF_SCHEMA_VERSION,
      candidateValidation: "invalid",
      changedSections: Object.freeze([]),
      semanticChange: null,
    });
  }
}
