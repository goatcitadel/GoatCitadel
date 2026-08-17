import {
  ConflictError,
  SemanticValidationError,
  type ChangePlanProviderConnectionRequest,
  type ChangePlanRecord,
  type LlmProviderConfig,
  type LlmProviderSummary,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";

export interface ProviderConnectionChangePlanAdapterDependencies {
  readonly getSettings: () => Promise<RuntimeSettings>;
  readonly getProviderConfig?: (providerId: string) => LlmProviderConfig | undefined;
  readonly updateSettings: (input: UpdateSettingsInput) => Promise<RuntimeSettings>;
  readonly hasTemporarySecret: (planId: string, providerId: string) => boolean | Promise<boolean>;
  readonly hasTemporaryOAuthCredential?: (planId: string, providerId: string) => boolean | Promise<boolean>;
  readonly promoteTemporarySecret: (
    planId: string,
    providerId: string,
    expectedRevision: number,
    storage?: "keychain" | "env",
    envVar?: string,
  ) => Promise<{ revision: number; evidenceRefs: readonly string[] }>;
  readonly promoteTemporaryOAuthCredential?: (
    planId: string,
    providerId: string,
    expectedRevision: number,
  ) => Promise<{ revision: number; evidenceRefs: readonly string[] }>;
  readonly removeProviderApiKey: (
    providerId: string,
    expectedRevision: number,
    storage?: "all" | "keychain" | "env" | "inline",
  ) => Promise<{ revision: number; evidenceRefs: readonly string[] }>;
  readonly removeProviderOAuthCredential?: (
    providerId: string,
    expectedRevision: number,
  ) => Promise<{ revision: number; evidenceRefs: readonly string[] }>;
  readonly getProviderApiKeyStatus: (providerId: string) => {
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  };
  readonly getProviderOAuthCredentialStatus?: (
    providerId: string,
  ) => { connected: boolean } | Promise<{ connected: boolean }>;
  readonly discardTemporarySecret: (planId: string, providerId: string) => void | Promise<void>;
  readonly discardTemporaryOAuthCredential?: (planId: string, providerId: string) => void | Promise<void>;
  readonly verifyProvider: (providerId: string) => Promise<{ evidenceRefs: readonly string[] }>;
}

/** Credential values stay in a dedicated temporary keychain owner; the plan retains only references. */
export class ProviderConnectionChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanProviderConnectionRequest> {
  public readonly adapterId = "provider-connection";
  public readonly version = 5;
  public readonly kinds = ["provider_connection"] as const;

  public constructor(private readonly deps: ProviderConnectionChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanProviderConnectionRequest) {
    const settings = await this.deps.getSettings();
    const provider = settings.llm.providers.find((candidate) => candidate.providerId === request.providerId);
    if (!provider && !request.profile) {
      throw new SemanticValidationError(
        `LLM provider ${request.providerId} is not configured and no safe profile was supplied.`,
      );
    }
    const label = request.profile?.label ?? provider?.label ?? request.providerId;
    const credentialAction = request.credentialAction;
    if (credentialAction && !provider && credentialAction !== "remove_oauth") {
      throw new SemanticValidationError(
        `LLM provider ${request.providerId} must exist before its credential can be changed.`,
      );
    }
    if (
      credentialAction &&
      !["replace_oauth", "remove_oauth"].includes(credentialAction) &&
      isOAuthAuthMode(request.profile?.authMode ?? provider?.authMode)
    ) {
      throw new SemanticValidationError("OAuth credentials must use the provider's dedicated OAuth lifecycle.");
    }
    if (credentialAction === "replace_oauth" && !isOAuthAuthMode(provider?.authMode)) {
      throw new SemanticValidationError("OAuth replacement requires an OAuth-backed provider.");
    }
    if (
      credentialAction === "remove_oauth" &&
      !isOAuthAuthMode(provider?.authMode) &&
      request.providerId.trim().toLowerCase() !== "openai-codex"
    ) {
      throw new SemanticValidationError("OAuth removal requires an OAuth-backed provider.");
    }
    const profileChange = Boolean(
      request.profile && !providerProfileMatches(provider, request, this.deps.getProviderConfig?.(request.providerId)),
    );
    const ready = provider ? providerIsReady(provider) : false;
    const oauth = isOAuthAuthMode(request.profile?.authMode ?? provider?.authMode);
    const removing = credentialAction === "remove_api_key";
    const removingOAuth = credentialAction === "remove_oauth";
    const replacing = credentialAction === "replace_api_key";
    const replacingOAuth = credentialAction === "replace_oauth";
    const status =
      profileChange || removing || removingOAuth || (ready && !replacing && !replacingOAuth)
        ? ("awaiting_confirmation" as const)
        : ("awaiting_input" as const);
    return {
      target: {
        ownerId: "provider_connection",
        resourceId: request.providerId,
        expectedRevision: settings.revision,
      },
      title: `${profileChange ? (provider ? "Update" : "Add") : removing ? "Remove API key from" : removingOAuth ? "Disconnect OAuth from" : replacing ? "Replace API key for" : replacingOAuth ? "Reauthorize" : ready ? "Verify" : "Connect"} ${label}`,
      summary: profileChange
        ? `${provider ? "Update" : "Create"} the exact secret-free ${label} profile before any credential is requested.`
        : removing
          ? `Remove the reviewed ${request.credentialDeleteScope ?? "all"} API-key source from ${label}.`
          : removingOAuth
            ? `Remove the canonical OAuth credential for ${label} without exposing its value.`
            : replacing
              ? `Replace the ${label} API key through the Gateway's dedicated secure credential flow.`
              : replacingOAuth
                ? `Stage a replacement ${label} OAuth credential without changing the active connection until exact confirmation.`
                : ready
                  ? `${label} is already configured. Verify its live model catalog before keeping this connection.`
                  : `Connect ${label} through the Gateway's dedicated ${oauth ? "OAuth" : "secure credential"} flow.`,
      impact: "The credential remains outside Chat and model context. A live provider check runs before completion.",
      risk: removing || removingOAuth ? ("caution" as const) : ("safe" as const),
      status,
      requiredAction:
        profileChange || removing || removingOAuth || (ready && !replacing && !replacingOAuth)
          ? context.actions.confirmation({
              title: `${profileChange ? "Confirm profile for" : removing ? "Confirm API-key removal for" : "Verify"} ${label}`,
              confirmationText: profileChange
                ? `Write only the reviewed secret-free ${label} provider profile. Credentials stay in the dedicated owner flow.`
                : removing
                  ? `Remove only the approved ${request.credentialDeleteScope ?? "all"} API-key source from ${label}.`
                  : removingOAuth
                    ? `Disconnect only the canonical OAuth credential owned by ${label}.`
                    : `Run a live, read-only provider verification for ${label}.`,
            })
          : oauth
            ? context.actions.oauth({ targetId: request.providerId, title: `Authorize ${label}` })
            : context.actions.secureInput({
                targetId: request.providerId,
                title: `Enter ${label} credential`,
                expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                fields: [
                  {
                    fieldId: "credential",
                    label: `${label} credential`,
                    required: true,
                    description: "Stored in the OS keychain and never added to Chat or model context.",
                  },
                ],
              }),
    };
  }

  public async resumeOwnerInput(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    if (receipt.ownerResourceId !== request.providerId) {
      throw new ConflictError({ message: "Provider connection owner receipt does not match this Change Plan." });
    }
    if (receipt.actionKind === "secure_input") {
      if (receipt.ownerId !== "provider_temporary_secret") {
        throw new ConflictError({ message: "Provider secure-input receipt owner is invalid." });
      }
      if (!(await this.deps.hasTemporarySecret(plan.planId, request.providerId))) {
        throw new SemanticValidationError("The temporary provider credential is unavailable. Enter it again.");
      }
    } else if (receipt.actionKind === "oauth") {
      if (receipt.ownerId !== "provider_oauth") {
        throw new ConflictError({ message: "Provider OAuth receipt owner is invalid." });
      }
      if (!(await this.deps.hasTemporaryOAuthCredential?.(plan.planId, request.providerId))) {
        throw new SemanticValidationError(
          "The temporary provider OAuth credential is unavailable. Authorize it again.",
        );
      }
    } else {
      throw new ConflictError({ message: "Provider connection received an unsupported owner action." });
    }
    const settings = await this.deps.getSettings();
    const provider = requireProvider(settings, request.providerId);
    return {
      status: "awaiting_confirmation",
      evidenceRefs: receipt.evidenceRefs,
      requiredAction: context.actions.confirmation({
        title: `Confirm ${provider.label} connection`,
        confirmationText: `Promote the verified ${provider.label} connection and keep only its secure owner reference.`,
      }),
      result: { summary: `${provider.label} input was verified and is ready for final confirmation.` },
    };
  }

  public async apply(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    let settings = await this.deps.getSettings();
    assertRevision(plan, settings.revision);
    const before = settings.llm.providers.find((candidate) => candidate.providerId === request.providerId);
    if (
      request.profile &&
      !providerProfileMatches(before, request, this.deps.getProviderConfig?.(request.providerId))
    ) {
      settings = await this.deps.updateSettings({
        expectedRevision: settings.revision,
        llm: { upsertProvider: providerSettingsPatch(request) },
      });
    }
    if (request.credentialAction === "remove_api_key") {
      const removed = await this.deps.removeProviderApiKey(
        request.providerId,
        settings.revision,
        request.credentialDeleteScope ?? "all",
      );
      return {
        status: "verifying",
        evidenceRefs: removed.evidenceRefs,
        result: {
          summary: `${requireProvider(await this.deps.getSettings(), request.providerId).label} API-key removal completed.`,
          appliedRevision: removed.revision,
        },
      };
    }
    if (request.credentialAction === "remove_oauth") {
      if (!this.deps.removeProviderOAuthCredential) {
        throw new SemanticValidationError("The provider OAuth removal owner is unavailable.");
      }
      const removed = await this.deps.removeProviderOAuthCredential(request.providerId, settings.revision);
      return {
        status: "verifying",
        evidenceRefs: removed.evidenceRefs,
        result: {
          summary: `${before?.label ?? request.providerId} OAuth credential was disconnected.`,
          appliedRevision: removed.revision,
        },
      };
    }
    const hasTemporarySecret = await this.deps.hasTemporarySecret(plan.planId, request.providerId);
    const provider = requireProvider(settings, request.providerId);
    const oauth = isOAuthProvider(provider);
    const hasTemporaryOAuthCredential = oauth
      ? ((await this.deps.hasTemporaryOAuthCredential?.(plan.planId, request.providerId)) ?? false)
      : false;
    const requiresCredential =
      ["replace_api_key", "replace_oauth"].includes(request.credentialAction ?? "") || !providerIsReady(provider);
    if (requiresCredential && !hasTemporarySecret && !hasTemporaryOAuthCredential) {
      return {
        status: "awaiting_input",
        target: { ...plan.target, expectedRevision: settings.revision },
        evidenceRefs: [`provider_profile:${provider.providerId}:settings_revision:${settings.revision}`],
        requiredAction: oauth
          ? context.actions.oauth({ targetId: provider.providerId, title: `Authorize ${provider.label}` })
          : context.actions.secureInput({
              targetId: provider.providerId,
              title: `Enter ${provider.label} credential`,
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              fields: [
                {
                  fieldId: "credential",
                  label: `${provider.label} credential`,
                  required: true,
                  description: "Stored in the OS keychain and never added to Chat or model context.",
                },
              ],
            }),
        result: {
          summary: `${provider.label} profile saved. Its credential is still required through the secure owner flow.`,
        },
      };
    }
    if (hasTemporaryOAuthCredential && !this.deps.promoteTemporaryOAuthCredential) {
      throw new SemanticValidationError("The provider OAuth promotion owner is unavailable.");
    }
    const promoted = hasTemporaryOAuthCredential
      ? await this.deps.promoteTemporaryOAuthCredential!(plan.planId, request.providerId, settings.revision)
      : hasTemporarySecret
        ? await this.deps.promoteTemporarySecret(
            plan.planId,
            request.providerId,
            settings.revision,
            request.credentialStorage,
            request.credentialEnvVar,
          )
        : { revision: settings.revision, evidenceRefs: [] as readonly string[] };
    const verification = await this.deps.verifyProvider(request.providerId);
    return {
      status: "verifying",
      evidenceRefs: [...promoted.evidenceRefs, ...verification.evidenceRefs],
      result: {
        summary: `${requireProvider(await this.deps.getSettings(), request.providerId).label} is securely connected and passed live verification.`,
        appliedRevision: promoted.revision,
      },
    };
  }

  public async verify(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const request = requireRequest(plan);
    if (request.credentialAction === "remove_api_key") {
      const status = this.deps.getProviderApiKeyStatus(request.providerId);
      const scope = request.credentialDeleteScope ?? "all";
      const removed = scope === "all" ? !status.hasSecret : status.source !== scope;
      return removed
        ? {
            status: "completed",
            evidenceRefs: [`provider:${request.providerId}:api_key:${scope}:absent`],
            result: plan.result ?? { summary: "The approved provider API-key source is absent." },
          }
        : {
            status: "manual_required",
            result: {
              summary: "The approved provider API-key source is still present.",
              failureCode: "provider_secret_removal_failed",
            },
          };
    }
    if (request.credentialAction === "remove_oauth") {
      const removed = await this.isOAuthCredentialAbsent(request.providerId);
      return removed
        ? {
            status: "completed",
            evidenceRefs: [`provider:${request.providerId}:oauth:absent`],
            result: plan.result ?? { summary: "The approved provider OAuth credential is absent." },
          }
        : {
            status: "manual_required",
            result: {
              summary: "The approved provider OAuth credential is still present.",
              failureCode: "provider_oauth_removal_failed",
            },
          };
    }
    try {
      const verification = await this.deps.verifyProvider(request.providerId);
      await this.deps.discardTemporarySecret(plan.planId, request.providerId);
      await this.deps.discardTemporaryOAuthCredential?.(plan.planId, request.providerId);
      return {
        status: "completed",
        evidenceRefs: verification.evidenceRefs,
        result: plan.result ?? { summary: "The provider connection passed live verification." },
      };
    } catch {
      return {
        status: "manual_required",
        result: {
          summary: "The provider owner did not pass post-apply verification.",
          failureCode: "provider_verification_failed",
        },
      };
    }
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    if (request.credentialAction === "remove_api_key") {
      const status = this.deps.getProviderApiKeyStatus(request.providerId);
      const scope = request.credentialDeleteScope ?? "all";
      const removed = scope === "all" ? !status.hasSecret : status.source !== scope;
      return removed
        ? {
            effectObserved: true,
            status: "completed" as const,
            evidenceRefs: [`provider:${request.providerId}:api_key:${scope}:absent`],
            result: plan.result ?? { summary: "Owner state proves the approved API-key source is absent." },
          }
        : {
            effectObserved: false,
            status: "manual_required" as const,
            result: {
              summary: "Provider API-key removal could not be proven after restart.",
              failureCode: "ambiguous_recovery",
            },
          };
    }
    if (request.credentialAction === "remove_oauth") {
      const removed = await this.isOAuthCredentialAbsent(request.providerId);
      return removed
        ? {
            effectObserved: true,
            status: "completed" as const,
            evidenceRefs: [`provider:${request.providerId}:oauth:absent`],
            result: plan.result ?? { summary: "Owner state proves the OAuth credential is absent." },
          }
        : {
            effectObserved: false,
            status: "manual_required" as const,
            result: { summary: "OAuth removal could not be proven after restart.", failureCode: "ambiguous_recovery" },
          };
    }
    try {
      const verification = await this.deps.verifyProvider(request.providerId);
      await this.deps.discardTemporarySecret(plan.planId, request.providerId);
      await this.deps.discardTemporaryOAuthCredential?.(plan.planId, request.providerId);
      return {
        effectObserved: true,
        status: "completed" as const,
        evidenceRefs: verification.evidenceRefs,
        result: plan.result ?? { summary: "Owner state proves the provider connection is active." },
      };
    } catch {
      return {
        effectObserved: false,
        status: "manual_required" as const,
        result: {
          summary:
            "The provider connection could not be proven after restart; the Gateway did not replay credential promotion.",
          failureCode: "ambiguous_recovery",
        },
      };
    }
  }

  public async discard(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): Promise<void> {
    const request = requireRequest(plan);
    await this.deps.discardTemporarySecret(plan.planId, request.providerId);
    await this.deps.discardTemporaryOAuthCredential?.(plan.planId, request.providerId);
  }

  private async isOAuthCredentialAbsent(providerId: string): Promise<boolean> {
    if (!this.deps.getProviderOAuthCredentialStatus) {
      return false;
    }
    return !(await this.deps.getProviderOAuthCredentialStatus(providerId)).connected;
  }
}

function providerSettingsPatch(request: ChangePlanProviderConnectionRequest) {
  const profile = request.profile;
  if (!profile) throw new SemanticValidationError("The provider profile is unavailable.");
  return {
    providerId: request.providerId,
    ...(profile.label !== undefined ? { label: profile.label } : {}),
    ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.apiStyle !== undefined ? { apiStyle: profile.apiStyle } : {}),
    ...(profile.authMode !== undefined ? { authMode: profile.authMode } : {}),
    ...(profile.defaultModel !== undefined ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(profile.googleCloud !== undefined ? { googleCloud: profile.googleCloud } : {}),
    ...(profile.capabilities !== undefined ? { capabilities: profile.capabilities } : {}),
  };
}

function providerProfileMatches(
  provider: LlmProviderSummary | undefined,
  request: ChangePlanProviderConnectionRequest,
  config?: LlmProviderConfig,
): boolean {
  if (!provider || !request.profile) return false;
  const profile = request.profile;
  return (
    (profile.label === undefined || provider.label === profile.label) &&
    (profile.baseUrl === undefined || provider.baseUrl === profile.baseUrl) &&
    (profile.apiStyle === undefined || provider.apiStyle === profile.apiStyle) &&
    (profile.authMode === undefined || provider.authMode === profile.authMode) &&
    (profile.defaultModel === undefined || provider.defaultModel === profile.defaultModel) &&
    (profile.apiKeyEnv === undefined || config?.apiKeyEnv === profile.apiKeyEnv) &&
    (profile.googleCloud === undefined ||
      JSON.stringify(provider.googleCloud ?? {}) === JSON.stringify(profile.googleCloud)) &&
    (profile.capabilities === undefined ||
      Object.entries(profile.capabilities).every(
        ([key, value]) =>
          (provider.capabilities as unknown as Record<string, unknown> | undefined)?.[key] === value ||
          JSON.stringify((provider.capabilities as unknown as Record<string, unknown> | undefined)?.[key]) ===
            JSON.stringify(value),
      ))
  );
}

export function providerTemporarySecretAccount(planId: string, providerId: string): string {
  return `evolution:provider:${planId}:${providerId.trim().toLowerCase()}`;
}

export function providerTemporaryOAuthAccount(planId: string, providerId: string): string {
  return `evolution:provider-oauth:${planId}:${providerId.trim().toLowerCase()}`;
}

function requireRequest(plan: ChangePlanRecord): ChangePlanProviderConnectionRequest {
  if (plan.request.kind !== "provider_connection") {
    throw new SemanticValidationError("Provider connection Change Plan kind drifted.");
  }
  return plan.request;
}

function requireProvider(settings: RuntimeSettings, providerId: string): LlmProviderSummary {
  const provider = settings.llm.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) throw new SemanticValidationError(`LLM provider ${providerId} is not configured.`);
  return provider;
}

function providerIsReady(provider: LlmProviderSummary): boolean {
  return provider.authReadiness
    ? ["configured", "ready"].includes(provider.authReadiness.status)
    : provider.hasApiKey || provider.oauthStatus?.connected === true || provider.authMode === "google-adc";
}

function isOAuthProvider(provider: LlmProviderSummary): boolean {
  return isOAuthAuthMode(provider.authMode);
}

// claude-code-oauth is deliberately excluded: its credential is a long-lived pasted
// token (`claude setup-token`), not a gateway-driven OAuth exchange, so it flows
// through the secure-input API-key lifecycle like any other secret.
function isOAuthAuthMode(authMode: LlmProviderSummary["authMode"] | undefined): boolean {
  return authMode === "codex-oauth";
}

function assertRevision(plan: ChangePlanRecord, currentRevision: number): void {
  if (plan.target.expectedRevision === currentRevision) return;
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: "Provider settings changed after this Change Plan was prepared.",
    details: { expectedRevision: plan.target.expectedRevision, currentRevision },
  });
}
