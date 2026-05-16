import type {
  AuthSettingsUpdateInput,
  DeviceAccessGrantListResponse,
  DeviceAccessGrantRevokeResponse,
  GatewayInstallTokenResolution,
  LlmProviderRequestConfig,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingState,
  PersonalityCatalogResponse,
  PersonalityPresetMutationInput,
} from "@goatcitadel/contracts";
import type { OnboardingCompleteResponse, RuntimeSettingsResponse } from "./types.js";
import { request } from "./client-core.js";

export async function fetchSettings(): Promise<RuntimeSettingsResponse> {
  return request<RuntimeSettingsResponse>("/api/v1/settings");
}

export async function fetchDeviceAccessGrants(
  view: "active" | "all" = "active",
): Promise<DeviceAccessGrantListResponse> {
  return request<DeviceAccessGrantListResponse>(`/api/v1/auth/devices?view=${encodeURIComponent(view)}`);
}

export async function revokeDeviceAccessGrant(grantId: string): Promise<DeviceAccessGrantRevokeResponse> {
  return request<DeviceAccessGrantRevokeResponse>(`/api/v1/auth/devices/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchOnboardingState(): Promise<OnboardingState> {
  return request<OnboardingState>("/api/v1/onboarding/state");
}

export async function bootstrapOnboarding(input: OnboardingBootstrapInput): Promise<OnboardingBootstrapResult> {
  return request<OnboardingBootstrapResult>("/api/v1/onboarding/bootstrap", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeOnboarding(completedBy?: string): Promise<OnboardingCompleteResponse> {
  return request<OnboardingCompleteResponse>("/api/v1/onboarding/complete", {
    method: "POST",
    body: JSON.stringify({
      completedBy,
    }),
  });
}

export async function resolveGatewayInstallToken(input?: {
  token?: string;
  generateWhenMissing?: boolean;
  persistToEnv?: boolean;
}): Promise<GatewayInstallTokenResolution> {
  return request<GatewayInstallTokenResolution>("/api/v1/auth/install-token", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function patchSettings(input: {
  deploymentProfile?: "local_dev" | "trusted_local" | "remote_hardened";
  defaultToolProfile?: string;
  budgetMode?: "saver" | "balanced" | "power";
  readAccessMode?: "roots_only" | "approval_required" | "full_disk";
  networkAllowlist?: string[];
  auth?: AuthSettingsUpdateInput;
  llm?: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?: "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages";
      authMode?: "api-key" | "codex-oauth" | "claude-code-oauth";
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      request?: LlmProviderRequestConfig;
      headers?: Record<string, string>;
    };
  };
  memory?: {
    enabled?: boolean;
    qmdEnabled?: boolean;
    qmdApplyToChat?: boolean;
    qmdApplyToOrchestration?: boolean;
    qmdMaxContextTokens?: number;
    qmdMinPromptChars?: number;
    qmdCacheTtlSeconds?: number;
    qmdDistillerProviderId?: string;
    qmdDistillerModel?: string;
  };
  web?: {
    firecrawl?: {
      enabled?: boolean;
      baseUrl?: string;
      apiKeyEnv?: string;
      timeoutMs?: number;
      defaultReadBackend?: "native" | "firecrawl";
      fallbackToNative?: boolean;
    };
  };
  mesh?: {
    enabled?: boolean;
    mode?: "lan" | "wan" | "tailnet";
    nodeId?: string;
    mdns?: boolean;
    staticPeers?: string[];
    requireMtls?: boolean;
    tailnetEnabled?: boolean;
  };
  npu?: {
    enabled?: boolean;
    autoStart?: boolean;
    sidecarUrl?: string;
  };
  llamaCpp?: {
    enabled?: boolean;
    autoStart?: boolean;
    baseUrl?: string;
    command?: string;
    extraArgs?: string[];
    modelsRootPath?: string;
    modelPath?: string;
    alias?: string;
    ctxSize?: number | null;
    threads?: number | null;
    gpuLayers?: number | null;
    parallel?: number | null;
    batchSize?: number | null;
    ubatchSize?: number | null;
    flashAttention?: boolean | null;
  };
  features?: Partial<RuntimeSettingsResponse["features"]>;
}): Promise<RuntimeSettingsResponse> {
  return request<RuntimeSettingsResponse>("/api/v1/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchPersonalities(): Promise<PersonalityCatalogResponse> {
  return request<PersonalityCatalogResponse>("/api/v1/personalities");
}

export async function createPersonality(input: PersonalityPresetMutationInput): Promise<PersonalityCatalogResponse> {
  return request<PersonalityCatalogResponse>("/api/v1/personalities", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePersonality(
  personalityId: string,
  input: PersonalityPresetMutationInput,
): Promise<PersonalityCatalogResponse> {
  return request<PersonalityCatalogResponse>(`/api/v1/personalities/${encodeURIComponent(personalityId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePersonality(personalityId: string): Promise<PersonalityCatalogResponse> {
  return request<PersonalityCatalogResponse>(`/api/v1/personalities/${encodeURIComponent(personalityId)}`, {
    method: "DELETE",
  });
}

export async function setDefaultPersonality(personalityId: string): Promise<PersonalityCatalogResponse> {
  return request<PersonalityCatalogResponse>("/api/v1/personalities/default", {
    method: "PATCH",
    body: JSON.stringify({ personalityId }),
  });
}
