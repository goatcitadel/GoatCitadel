import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import { BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE } from "@goatcitadel/policy-engine";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationRecipeRegistration,
} from "./governed-remediation-registry.js";

const MANAGED_BROWSER_TARGET_ID = "policy-engine.browser.playwright-chromium";
const MANAGED_BROWSER_CAPABILITY_ID = "browser.native.chromium.available";
const MANAGED_BROWSER_OWNER_ID = "policy-engine.browser-runtime";

export const GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE: GovernedRemediationRecipe =
  normalizeGovernedRemediationRecipe({
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "policy-engine.browser.playwright-chromium.manual-install",
    recipeVersion: 1,
    repairClass: "managed_dependency",
    ownerId: MANAGED_BROWSER_OWNER_ID,
    targetId: MANAGED_BROWSER_TARGET_ID,
    requestedCapabilityId: MANAGED_BROWSER_CAPABILITY_ID,
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

export const GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_REGISTRATION: GovernedRemediationRecipeRegistration = Object.freeze(
  {
    recipe: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE,
    owner: null,
  },
);

const MANUAL_MANAGED_BROWSER_REGISTRY = new GovernedRemediationRecipeRegistry([
  GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_REGISTRATION,
]);

export const GOVERNED_MANAGED_BROWSER_OBSERVATION_SCHEMA_VERSION =
  "goatcitadel.governed-remediation-managed-browser-observation.v1" as const;

export interface GovernedManagedBrowserObservation {
  readonly schemaVersion: typeof GOVERNED_MANAGED_BROWSER_OBSERVATION_SCHEMA_VERSION;
  readonly dependencyId: "playwright-chromium";
  readonly availability: "missing" | "unknown";
  readonly automaticInstallation: "disabled";
  readonly nativeBrowserCapability: "unavailable";
}

export type GovernedManagedBrowserManualReason = "operator_installation_required" | "source_diagnostic_unavailable";

export interface GovernedManagedBrowserAssessment {
  readonly status: "manual_required";
  readonly reason: GovernedManagedBrowserManualReason;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  readonly ownerRevision: null;
  readonly observation: GovernedManagedBrowserObservation;
  readonly automaticExecution: false;
}

export interface AssessGovernedManagedBrowserInput {
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
  /** Only the stable policy-engine diagnostic is accepted; raw launch errors never cross this boundary. */
  readonly sourceDiagnosticCode: unknown;
}

/**
 * Read-only classification for a missing Playwright Chromium dependency.
 *
 * Browser launch is intentionally not an installation owner: it has no
 * package-manager allowlist, pinned artifact provenance, exact installation
 * root, durable pre-effect journal, rollback, or restart reconciliation. The
 * adapter therefore accepts only the stable, secret-free missing-runtime code
 * and registers no callable owner. It never launches Chromium or invokes a
 * package manager.
 */
export class GovernedRemediationManagedBrowserAdapter {
  public assess(input: AssessGovernedManagedBrowserInput): GovernedManagedBrowserAssessment {
    const scope = normalizeGovernedRemediationScope(input.scope);
    const resolution = MANUAL_MANAGED_BROWSER_REGISTRY.resolve({
      recipeId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.recipeId,
      recipeVersion: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.recipeVersion,
      targetId: MANAGED_BROWSER_TARGET_ID,
      requestedCapabilityId: MANAGED_BROWSER_CAPABILITY_ID,
      deploymentProfile: input.deploymentProfile,
      scope,
    });
    const diagnosticAccepted = input.sourceDiagnosticCode === BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE;

    return Object.freeze({
      status: "manual_required",
      reason: diagnosticAccepted ? "operator_installation_required" : "source_diagnostic_unavailable",
      recipeId: resolution.recipe.recipeId,
      recipeVersion: resolution.recipe.recipeVersion,
      recipeSha256: resolution.recipeSha256,
      ownerId: resolution.recipe.ownerId,
      targetId: resolution.recipe.targetId,
      requestedCapabilityId: resolution.recipe.requestedCapabilityId,
      scope,
      ownerRevision: null,
      observation: Object.freeze({
        schemaVersion: GOVERNED_MANAGED_BROWSER_OBSERVATION_SCHEMA_VERSION,
        dependencyId: "playwright-chromium",
        availability: diagnosticAccepted ? "missing" : "unknown",
        automaticInstallation: "disabled",
        nativeBrowserCapability: "unavailable",
      }),
      automaticExecution: false,
    });
  }
}

export function governedManagedBrowserScope(input: {
  deploymentId: string;
  installationId: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: "goatcitadel.governed-remediation-scope.v1",
    deploymentId: input.deploymentId,
    scopeKind: "installation",
    scopeId: input.installationId,
    targetId: MANAGED_BROWSER_TARGET_ID,
  });
}

export function governedManagedBrowserRecipeSha256(): string {
  return governedRemediationRecipeSha256(GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE);
}
