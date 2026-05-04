import { logger } from "@goatcitadel/gateway-core";
import type {
  AuthRuntimeSettings,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingState,
  OnboardingStartupState,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { LlmService } from "./llm-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import * as onboardingMarkerHelpers from "./onboarding-marker-helpers.js";
import type * as settingsAuthService from "./settings-auth-service.js";

const log = logger.child("onboarding-state-service");
const onboardingTimingEnabled = process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING === "1";

export interface OnboardingStateHost {
  readonly config: GatewayRuntimeConfig;
  readonly llmService: Pick<LlmService, "getRuntimeConfig" | "getProviderSecretStatus" | "resolveExecutionApiStyle">;
  readonly onboardingMarkerPath: string;
  onboardingMarker: { completedAt?: string; completedBy?: string };
  getAuthRuntimeSettings(): AuthRuntimeSettings;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  updateSettings(input: settingsAuthService.UpdateSettingsInput): RuntimeSettings;
}

export function getOnboardingStartupState(runtime: OnboardingStateHost): OnboardingStartupState {
  return {
    completed: Boolean(runtime.onboardingMarker.completedAt),
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
  };
}

export function getOnboardingState(runtime: OnboardingStateHost): OnboardingState {
  const startedAt = Date.now();
  const auth = runtime.getAuthRuntimeSettings();
  const afterAuth = Date.now();
  const baseLlm = runtime.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: false,
    useCache: true,
  });
  const afterBaseLlm = Date.now();
  const activeProviderQuick = baseLlm.providers.find((provider) => provider.providerId === baseLlm.activeProviderId);
  const activeProviderStatus =
    activeProviderQuick && !activeProviderQuick.hasApiKey
      ? runtime.llmService.getProviderSecretStatus(baseLlm.activeProviderId, {
          includeKeychain: true,
          useCache: true,
        })
      : undefined;
  const afterActiveProviderStatus = Date.now();
  const llm = {
    ...baseLlm,
    providers: baseLlm.providers.map((provider) =>
      provider.providerId !== activeProviderStatus?.providerId
        ? provider
        : {
            ...provider,
            hasApiKey: activeProviderStatus.hasApiKey,
            apiKeySource: activeProviderStatus.apiKeySource,
            hasKeychainSecret: activeProviderStatus.hasKeychainSecret,
            apiKeyRef: activeProviderStatus.apiKeyRef,
          },
    ),
  };
  const afterLlmMap = Date.now();
  const mesh = {
    enabled: runtime.config.assistant.mesh.enabled,
    mode: runtime.config.assistant.mesh.mode,
    nodeId: runtime.config.assistant.mesh.nodeId,
    mdns: runtime.config.assistant.mesh.discovery.mdns,
    staticPeers: runtime.config.assistant.mesh.discovery.staticPeers,
    requireMtls: runtime.config.assistant.mesh.security.requireMtls,
    tailnetEnabled: runtime.config.assistant.mesh.security.tailnet.enabled,
  };
  const toolApprovalMode =
    runtime.config.toolPolicy.tools.approvalMode ??
    (runtime.config.toolPolicy.tools.profile === "danger" ? "bypass" : "approve_risky");
  const defaultToolProfile = runtime.config.toolPolicy.tools.profile ?? "";
  const budgetMode = runtime.config.budgets.mode;
  const networkAllowlist = runtime.config.toolPolicy.sandbox.networkAllowlist;
  const activeProvider = llm.providers.find((provider) => provider.providerId === llm.activeProviderId);
  const authReady = isAuthConfiguredForMode(auth);
  const llmReady = Boolean(
    activeProvider &&
    llm.activeModel.trim() &&
    (activeProvider.hasApiKey || isProviderLikelyLocal(activeProvider.baseUrl)),
  );
  const runtimeReady = Boolean(toolApprovalMode.trim()) && Boolean(budgetMode.trim());
  const meshReady = mesh.enabled
    ? Boolean(mesh.nodeId.trim()) && (mesh.mode !== "tailnet" || mesh.tailnetEnabled)
    : true;
  const afterReadiness = Date.now();

  const checklist: OnboardingState["checklist"] = [
    {
      id: "auth",
      label: "Gateway access control",
      status: authReady ? "complete" : "needs_input",
      detail: authReady
        ? `Mode ${auth.mode} is configured.`
        : "Configure token/basic credentials or explicitly choose none for local trusted use.",
    },
    {
      id: "llm",
      label: "LLM provider",
      status: llmReady ? "complete" : "needs_input",
      detail: llmReady
        ? `Provider ${llm.activeProviderId} with model ${llm.activeModel} is ready.`
        : "Select an active provider/model and configure an API key (or use a local endpoint).",
    },
    {
      id: "runtime",
      label: "Runtime defaults",
      status: runtimeReady ? "complete" : "needs_input",
      detail: runtimeReady
        ? `Tool approvals ${toolApprovalMode} / budget ${budgetMode}.`
        : "Choose a tool approval mode and budget mode.",
    },
    {
      id: "mesh",
      label: "Mesh (optional)",
      status: mesh.enabled ? (meshReady ? "complete" : "needs_input") : "optional",
      detail: mesh.enabled ? `Mesh ${mesh.mode} on node ${mesh.nodeId}.` : "Mesh disabled. You can enable this later.",
    },
  ];
  const afterChecklist = Date.now();
  const projectedProviders = llm.providers.map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
    resolvedApiStyle: runtime.llmService.resolveExecutionApiStyle(provider.providerId, provider.defaultModel),
    defaultModel: provider.defaultModel,
    hasApiKey: provider.hasApiKey,
    apiKeySource: provider.apiKeySource,
    hasKeychainSecret: provider.hasKeychainSecret,
    apiKeyRef: provider.apiKeyRef,
  }));
  const afterProviderProjection = Date.now();

  const response: OnboardingState = {
    completed: Boolean(runtime.onboardingMarker.completedAt),
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
    checklist,
    settings: {
      toolApprovalMode,
      defaultToolProfile,
      budgetMode,
      networkAllowlist,
      auth,
      llm: {
        activeProviderId: llm.activeProviderId,
        activeModel: llm.activeModel,
        providers: projectedProviders,
      },
      mesh,
    },
  };
  const completedAt = Date.now();
  if (onboardingTimingEnabled) {
    log.info("onboarding state timing", {
      totalMs: completedAt - startedAt,
      authMs: afterAuth - startedAt,
      baseLlmMs: afterBaseLlm - afterAuth,
      activeProviderStatusMs: afterActiveProviderStatus - afterBaseLlm,
      llmMapMs: afterLlmMap - afterActiveProviderStatus,
      readinessMs: afterReadiness - afterLlmMap,
      checklistMs: afterChecklist - afterReadiness,
      providerProjectionMs: afterProviderProjection - afterChecklist,
      responseWrapMs: completedAt - afterProviderProjection,
      assembleMs: completedAt - afterLlmMap,
      providerCount: llm.providers.length,
      activeProviderId: llm.activeProviderId,
      activeProviderQuickHasApiKey: activeProviderQuick?.hasApiKey ?? null,
      activeProviderStatusSource: activeProviderStatus?.apiKeySource ?? null,
    });
  }
  return response;
}

export function bootstrapOnboarding(
  runtime: OnboardingStateHost,
  input: OnboardingBootstrapInput,
): OnboardingBootstrapResult {
  runtime.updateSettings({
    toolApprovalMode: input.toolApprovalMode,
    defaultToolProfile: input.defaultToolProfile,
    budgetMode: input.budgetMode,
    networkAllowlist: input.networkAllowlist,
    auth: input.auth,
    llm: input.llm,
    mesh: input.mesh,
  });

  if (input.markComplete) {
    markOnboardingComplete(runtime, input.completedBy ?? "operator");
  }

  return {
    state: getOnboardingState(runtime),
    appliedAt: new Date().toISOString(),
  };
}

export function markOnboardingComplete(runtime: OnboardingStateHost, completedBy = "operator"): OnboardingState {
  runtime.onboardingMarker = {
    completedAt: new Date().toISOString(),
    completedBy: completedBy.trim() || "operator",
  };
  onboardingMarkerHelpers.persistOnboardingMarker(runtime);
  runtime.publishRealtime("system", "onboarding", {
    type: "onboarding_completed",
    completedAt: runtime.onboardingMarker.completedAt,
    completedBy: runtime.onboardingMarker.completedBy,
  });
  return getOnboardingState(runtime);
}

function isAuthConfiguredForMode(auth: RuntimeSettings["auth"]): boolean {
  if (auth.mode === "none") {
    return true;
  }
  if (auth.mode === "token") {
    return auth.tokenConfigured;
  }
  return auth.basicConfigured;
}

function isProviderLikelyLocal(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
