import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import type { DaemonRouteService } from "./daemon-route-service.js";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationRecipeRegistration,
} from "./governed-remediation-registry.js";

const GATEWAY_SERVICE_TARGET_ID = "gateway.service.lifecycle";
const GATEWAY_SERVICE_CAPABILITY_ID = "gateway.service.authenticated-readiness";
const GATEWAY_SERVICE_OWNER_ID = "gateway.daemon-lifecycle";

export const GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE: GovernedRemediationRecipe =
  normalizeGovernedRemediationRecipe({
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "gateway.service.lifecycle.manual-repair",
    recipeVersion: 1,
    repairClass: "owned_service",
    ownerId: GATEWAY_SERVICE_OWNER_ID,
    targetId: GATEWAY_SERVICE_TARGET_ID,
    requestedCapabilityId: GATEWAY_SERVICE_CAPABILITY_ID,
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

export const GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_REGISTRATION: GovernedRemediationRecipeRegistration = Object.freeze(
  {
    recipe: GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE,
    owner: null,
  },
);

const MANUAL_GATEWAY_SERVICE_REGISTRY = new GovernedRemediationRecipeRegistry([
  GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_REGISTRATION,
]);

export const GOVERNED_GATEWAY_SERVICE_OBSERVATION_SCHEMA_VERSION =
  "goatcitadel.governed-remediation-gateway-service-observation.v1" as const;

export interface GovernedGatewayServiceObservation {
  readonly schemaVersion: typeof GOVERNED_GATEWAY_SERVICE_OBSERVATION_SCHEMA_VERSION;
  readonly processObserved: boolean;
  readonly lifecycleControl: "external_owner_required" | "unavailable";
  readonly authenticatedReadinessProbe: "not_owned";
}

export type GovernedGatewayServiceManualReason =
  | "external_process_manager_required"
  | "gateway_process_not_observable"
  | "durable_lifecycle_owner_unavailable";

export interface GovernedGatewayServiceAssessment {
  readonly status: "manual_required";
  readonly reason: GovernedGatewayServiceManualReason;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  readonly ownerRevision: null;
  readonly observation: GovernedGatewayServiceObservation;
  readonly automaticExecution: false;
}

/**
 * Read-only classification for Gateway lifecycle repair.
 *
 * The current daemon surface observes the process that serves the request. It
 * intentionally rejects start/stop/restart because no trusted process-manager
 * owner can prove executable identity, drain, effect attribution, restart
 * reconciliation, authenticated readiness, or rollback across process death.
 * This adapter therefore emits only fixed booleans/enums and never forwards
 * daemon diagnostics, PIDs, hostnames, environment values, commands, or logs.
 */
export class GovernedRemediationOwnedGatewayServiceAdapter {
  public constructor(private readonly daemon: Pick<DaemonRouteService, "getDaemonStatus">) {}

  public async assess(input: {
    readonly deploymentProfile: DeploymentProfile;
    readonly scope: GovernedRemediationScope;
  }): Promise<GovernedGatewayServiceAssessment> {
    const scope = normalizeGovernedRemediationScope(input.scope);
    const resolution = MANUAL_GATEWAY_SERVICE_REGISTRY.resolve({
      recipeId: GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE.recipeId,
      recipeVersion: GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE.recipeVersion,
      targetId: GATEWAY_SERVICE_TARGET_ID,
      requestedCapabilityId: GATEWAY_SERVICE_CAPABILITY_ID,
      deploymentProfile: input.deploymentProfile,
      scope,
    });
    const status = await this.daemon.getDaemonStatus();
    const processObserved = status.running === true;
    const externalOwnerRequired = status.supported !== true || status.controllable !== true;

    return Object.freeze({
      status: "manual_required",
      reason: !processObserved
        ? "gateway_process_not_observable"
        : externalOwnerRequired
          ? "external_process_manager_required"
          : "durable_lifecycle_owner_unavailable",
      recipeId: resolution.recipe.recipeId,
      recipeVersion: resolution.recipe.recipeVersion,
      recipeSha256: resolution.recipeSha256,
      ownerId: resolution.recipe.ownerId,
      targetId: resolution.recipe.targetId,
      requestedCapabilityId: resolution.recipe.requestedCapabilityId,
      scope,
      ownerRevision: null,
      observation: Object.freeze({
        schemaVersion: GOVERNED_GATEWAY_SERVICE_OBSERVATION_SCHEMA_VERSION,
        processObserved,
        lifecycleControl: externalOwnerRequired ? "external_owner_required" : "unavailable",
        authenticatedReadinessProbe: "not_owned",
      }),
      automaticExecution: false,
    });
  }
}

export function governedGatewayServiceScope(input: {
  readonly deploymentId: string;
  readonly installationId: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: "goatcitadel.governed-remediation-scope.v1",
    deploymentId: input.deploymentId,
    scopeKind: "installation",
    scopeId: input.installationId,
    targetId: GATEWAY_SERVICE_TARGET_ID,
  });
}

export function governedGatewayServiceRecipeSha256(): string {
  return governedRemediationRecipeSha256(GOVERNED_GATEWAY_SERVICE_MANUAL_REPAIR_RECIPE);
}
