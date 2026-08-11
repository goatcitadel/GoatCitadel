import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  governedRemediationRecipeSha256,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationScope,
  type DeploymentProfile,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import type { OpenAICodexOAuthService, OpenAICodexOAuthStatus } from "./openai-codex-oauth-service.js";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationRecipeRegistration,
} from "./governed-remediation-registry.js";

const OPENAI_CODEX_OAUTH_TARGET_ID = "gateway.llm.provider.openai-codex.oauth-owner";
const OPENAI_CODEX_OAUTH_CAPABILITY_ID = "llm.provider.openai-codex.oauth-credential-present";
const OPENAI_CODEX_OAUTH_OWNER_ID = "gateway.openai-codex-oauth";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export const GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE: GovernedRemediationRecipe =
  normalizeGovernedRemediationRecipe({
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "provider.openai-codex.oauth.manual-reconnect",
    recipeVersion: 1,
    repairClass: "oauth_connection",
    ownerId: OPENAI_CODEX_OAUTH_OWNER_ID,
    targetId: OPENAI_CODEX_OAUTH_TARGET_ID,
    requestedCapabilityId: OPENAI_CODEX_OAUTH_CAPABILITY_ID,
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

export const GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_REGISTRATION: GovernedRemediationRecipeRegistration =
  Object.freeze({
    recipe: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE,
    owner: null,
  });

const MANUAL_OPENAI_CODEX_OAUTH_REGISTRY = new GovernedRemediationRecipeRegistry([
  GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_REGISTRATION,
]);

export const GOVERNED_OPENAI_CODEX_OAUTH_OBSERVATION_SCHEMA_VERSION =
  "goatcitadel.governed-remediation-openai-codex-oauth-observation.v1" as const;

export interface GovernedOpenAICodexOAuthObservation {
  readonly schemaVersion: typeof GOVERNED_OPENAI_CODEX_OAUTH_OBSERVATION_SCHEMA_VERSION;
  readonly secretStore: "available" | "unavailable" | "unknown";
  readonly credential: "present" | "missing" | "reauth_required" | "unknown";
  readonly credentialExpiry: "future" | "expired" | "not_reported" | "invalid" | "unknown";
  /** Account labels may contain personal email addresses, so only presence crosses this boundary. */
  readonly accountLabelPresent: boolean | null;
  /** The current owner has no non-mutating remote introspection endpoint. */
  readonly liveProbe: "unavailable";
}

export type GovernedOpenAICodexOAuthManualReason =
  | "owner_status_unavailable"
  | "secret_store_unavailable"
  | "oauth_credential_missing"
  | "oauth_reauthentication_required";

interface GovernedOpenAICodexOAuthAssessmentBase {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeSha256: string;
  readonly ownerId: string;
  readonly targetId: string;
  readonly requestedCapabilityId: string;
  readonly scope: GovernedRemediationScope;
  /** The current keychain owner exposes neither a revision nor compare-and-swap. */
  readonly ownerRevision: null;
  readonly observation: GovernedOpenAICodexOAuthObservation;
  readonly automaticExecution: false;
}

export type GovernedOpenAICodexOAuthAssessment =
  | (GovernedOpenAICodexOAuthAssessmentBase & {
      /** Local owner state has a stored credential; this is not a remote provider-health claim. */
      readonly status: "not_required";
    })
  | (GovernedOpenAICodexOAuthAssessmentBase & {
      readonly status: "manual_required";
      readonly reason: GovernedOpenAICodexOAuthManualReason;
    });

export interface AssessGovernedOpenAICodexOAuthInput {
  readonly deploymentProfile: DeploymentProfile;
  readonly scope: GovernedRemediationScope;
}

type OpenAICodexOAuthStatusReader = Pick<OpenAICodexOAuthService, "getStatus">;

/**
 * Read-only classification bridge for the installation-owned OpenAI Codex
 * OAuth credential.
 *
 * The OAuth owner is intentionally not callable through generic remediation:
 * its authorization flow is interactive and process-local, its keychain value
 * has no owner revision/CAS or durable effect identity, token refresh mutates
 * the credential, and there is no non-mutating remote verification endpoint.
 * Consequently there is no crash-safe pre-effect snapshot, restart
 * reconciliation, bounded rollback, or purpose-specific remediation approval
 * boundary to bind to the coordinator. This adapter publishes only coarse,
 * secret-free local owner state and registers `owner: null`.
 */
export class GovernedRemediationOpenAICodexOAuthAdapter {
  public constructor(
    private readonly oauth: OpenAICodexOAuthStatusReader,
    private readonly now: () => number = Date.now,
  ) {}

  public assess(input: AssessGovernedOpenAICodexOAuthInput): GovernedOpenAICodexOAuthAssessment {
    const scope = normalizeGovernedRemediationScope(input.scope);
    const resolution = MANUAL_OPENAI_CODEX_OAUTH_REGISTRY.resolve({
      recipeId: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.recipeId,
      recipeVersion: GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE.recipeVersion,
      targetId: OPENAI_CODEX_OAUTH_TARGET_ID,
      requestedCapabilityId: OPENAI_CODEX_OAUTH_CAPABILITY_ID,
      deploymentProfile: input.deploymentProfile,
      scope,
    });

    let status: OpenAICodexOAuthStatus;
    try {
      status = this.oauth.getStatus();
      if (status.providerId !== OPENAI_CODEX_PROVIDER_ID) {
        throw new TypeError("OpenAI Codex OAuth owner returned a mismatched provider binding.");
      }
    } catch {
      return Object.freeze({
        ...assessmentBase(resolution, scope, unknownObservation()),
        status: "manual_required",
        reason: "owner_status_unavailable",
      });
    }

    const observation = sanitizeObservation(status, this.now());
    const base = assessmentBase(resolution, scope, observation);
    if (!status.available) {
      return Object.freeze({ ...base, status: "manual_required", reason: "secret_store_unavailable" });
    }
    if (status.requiresReauth === true) {
      return Object.freeze({ ...base, status: "manual_required", reason: "oauth_reauthentication_required" });
    }
    if (!status.connected) {
      return Object.freeze({ ...base, status: "manual_required", reason: "oauth_credential_missing" });
    }
    return Object.freeze({ ...base, status: "not_required" });
  }
}

export function governedOpenAICodexOAuthScope(input: {
  deploymentId: string;
  installationId: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: "goatcitadel.governed-remediation-scope.v1",
    deploymentId: input.deploymentId,
    scopeKind: "installation",
    scopeId: input.installationId,
    targetId: OPENAI_CODEX_OAUTH_TARGET_ID,
  });
}

export function governedOpenAICodexOAuthRecipeSha256(): string {
  return governedRemediationRecipeSha256(GOVERNED_OPENAI_CODEX_OAUTH_MANUAL_REPAIR_RECIPE);
}

function assessmentBase(
  resolution: ReturnType<GovernedRemediationRecipeRegistry["resolve"]>,
  scope: GovernedRemediationScope,
  observation: GovernedOpenAICodexOAuthObservation,
): GovernedOpenAICodexOAuthAssessmentBase {
  return Object.freeze({
    recipeId: resolution.recipe.recipeId,
    recipeVersion: resolution.recipe.recipeVersion,
    recipeSha256: resolution.recipeSha256,
    ownerId: resolution.recipe.ownerId,
    targetId: resolution.recipe.targetId,
    requestedCapabilityId: resolution.recipe.requestedCapabilityId,
    scope,
    ownerRevision: null,
    observation,
    automaticExecution: false,
  });
}

function sanitizeObservation(status: OpenAICodexOAuthStatus, now: number): GovernedOpenAICodexOAuthObservation {
  if (!status.available) {
    return Object.freeze({
      schemaVersion: GOVERNED_OPENAI_CODEX_OAUTH_OBSERVATION_SCHEMA_VERSION,
      secretStore: "unavailable",
      credential: "unknown",
      credentialExpiry: "unknown",
      accountLabelPresent: null,
      liveProbe: "unavailable",
    });
  }
  return Object.freeze({
    schemaVersion: GOVERNED_OPENAI_CODEX_OAUTH_OBSERVATION_SCHEMA_VERSION,
    secretStore: "available",
    credential: status.requiresReauth === true ? "reauth_required" : status.connected ? "present" : "missing",
    credentialExpiry: sanitizeExpiry(status.expiresAt, now),
    accountLabelPresent: typeof status.accountLabel === "string" ? status.accountLabel.trim().length > 0 : false,
    liveProbe: "unavailable",
  });
}

function sanitizeExpiry(
  value: string | undefined,
  now: number,
): GovernedOpenAICodexOAuthObservation["credentialExpiry"] {
  if (value === undefined) return "not_reported";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "invalid";
  return timestamp > now ? "future" : "expired";
}

function unknownObservation(): GovernedOpenAICodexOAuthObservation {
  return Object.freeze({
    schemaVersion: GOVERNED_OPENAI_CODEX_OAUTH_OBSERVATION_SCHEMA_VERSION,
    secretStore: "unknown",
    credential: "unknown",
    credentialExpiry: "unknown",
    accountLabelPresent: null,
    liveProbe: "unavailable",
  });
}
