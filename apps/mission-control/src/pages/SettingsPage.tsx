/* eslint-disable @typescript-eslint/no-unused-vars, max-lines, react-hooks/exhaustive-deps */
import { useEffect, useMemo, useRef, useState } from "react";
import { providerTemplates, type DeviceAccessGrantRecord } from "@goatcitadel/contracts";
import {
  clearGatewayAuthState,
  createLlmChatCompletion,
  deleteProviderSecret,
  evaluateUiChangeRisk,
  fetchDeviceAccessGrants,
  getGatewayAuthStorageMode,
  persistGatewayAuthState,
  readStoredGatewayAuthState,
  revokeDeviceAccessGrant,
  fetchProviderSecretStatus,
  fetchSettings,
  patchSettings,
  saveProviderSecret,
  setGatewayAuthStorageMode,
  type GatewayAuthStorageMode,
  type ProviderSecretStatus,
} from "../api/client";
import { SettingsAccessSection } from "./settings/SettingsAccessSection";
import { SettingsOverviewSection } from "./settings/SettingsOverviewSection";
import { SettingsRuntimeSection } from "./settings/SettingsRuntimeSection";
import { SettingsModelsSection } from "./settings/SettingsModelsSection";
import { SettingsTestsSection } from "./settings/SettingsTestsSection";
import { SettingsVoiceSection } from "./settings/SettingsVoiceSection";
import { SettingsSectionNav } from "./settings/SettingsSectionNav";
import { formatDeploymentProfileLabel } from "./settings-page-utils";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { FieldHelp } from "../components/FieldHelp";
import { HelpHint } from "../components/HelpHint";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  LlmTransportFields,
  requestConfigFromDraft,
} from "../components/LlmTransportFields";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { SelectOrCustom, type SelectOption } from "../components/SelectOrCustom";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch } from "../components/ui";
import { pageCopy } from "../content/copy";
import { dedupeProviderModels, previewProviderModels, useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import type { SettingsTab } from "../content/page-registry";
import {
  CHAT_PROMPT_PRESETS,
  FIRECRAWL_DEFAULT_READ_BACKEND_OPTIONS,
  PROVIDER_API_STYLE_OPTIONS,
  READ_ACCESS_MODE_OPTIONS,
  SETTINGS_SECTIONS,
  TOOL_PROFILE_OPTIONS,
  isAbortError,
  type NormalizedRuntimeSettingsResponse,
  type ProviderApiStyle,
  type SettingsSectionId,
} from "./settings/settings-page-constants";
import {
  ALLOWLIST_PRESETS,
  buildProviderScopedModelOptions,
  getModelPreviewFallbackModel,
  matchAllowlistPreset,
  normalizeRuntimeSettingsResponse,
  resolveAuthStorageMode,
  resolveModelDraftHydration,
  resolveProviderModelSelection,
  resolveSettingsTabSection,
  resolveSettingsTabSections,
  scrollToSettingsSection,
} from "./settings/settings-page-helpers";
import { useSettingsVoiceRuntime } from "./settings/useSettingsVoiceRuntime";

export { resolveSettingsTabSection, resolveSettingsTabSections } from "./settings/settings-page-helpers";
import "../styles/settings.css";

export interface SettingsPageProps {
  activeTab?: SettingsTab;
  focusSectionId?: SettingsSectionId;
}

export function SettingsPage({ activeTab, focusSectionId }: SettingsPageProps = {}) {
  const [settings, setSettings] = useState<NormalizedRuntimeSettingsResponse | null>(null);
  const [deploymentProfile, setDeploymentProfile] = useState<"local_dev" | "trusted_local" | "remote_hardened">(
    "local_dev",
  );
  const [profile, setProfile] = useState("");
  const [budgetMode, setBudgetMode] = useState<"saver" | "balanced" | "power">("balanced");
  const [readAccessMode, setReadAccessMode] = useState<"roots_only" | "approval_required" | "full_disk">("roots_only");
  const [networkAllowlistText, setNetworkAllowlistText] = useState("");
  const [firecrawlEnabled, setFirecrawlEnabled] = useState(false);
  const [firecrawlBaseUrl, setFirecrawlBaseUrl] = useState("http://127.0.0.1:3002");
  const [firecrawlApiKeyEnv, setFirecrawlApiKeyEnv] = useState("FIRECRAWL_API_KEY");
  const [firecrawlTimeoutMs, setFirecrawlTimeoutMs] = useState(20000);
  const [firecrawlDefaultReadBackend, setFirecrawlDefaultReadBackend] = useState<"native" | "firecrawl">("native");
  const [firecrawlFallbackToNative, setFirecrawlFallbackToNative] = useState(true);

  const [activeProviderId, setActiveProviderId] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [providerId, setProviderId] = useState("custom");
  const [providerLabel, setProviderLabel] = useState("Custom");
  const [providerBaseUrl, setProviderBaseUrl] = useState("http://127.0.0.1:1234/v1");
  const [providerApiStyle, setProviderApiStyle] = useState<ProviderApiStyle>("openai-responses");
  const [providerDefaultModel, setProviderDefaultModel] = useState("local-model");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerApiKeyEnv, setProviderApiKeyEnv] = useState("");
  const [providerRequestDraft, setProviderRequestDraft] = useState(createEmptyLlmTransportDraft);
  const [providerSecretStatus, setProviderSecretStatus] = useState<ProviderSecretStatus | null>(null);
  const [hasUnsavedActiveLlmDraft, setHasUnsavedActiveLlmDraft] = useState(false);
  const [hasUnsavedProviderDraft, setHasUnsavedProviderDraft] = useState(false);
  const [authMode, setAuthMode] = useState<"none" | "token" | "basic">("none");
  const [allowLoopbackBypass, setAllowLoopbackBypass] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [basicPassword, setBasicPassword] = useState("");
  const [authStorageMode, setAuthStorageMode] = useState<GatewayAuthStorageMode>("session");
  const [deviceGrants, setDeviceGrants] = useState<DeviceAccessGrantRecord[]>([]);
  const [deviceGrantBusyId, setDeviceGrantBusyId] = useState<string | null>(null);
  const [models, setModels] = useState<Array<{ id: string; ownedBy?: string; created?: number }>>([]);
  const [previewedProviderId, setPreviewedProviderId] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelDiscoverySource, setModelDiscoverySource] = useState<"remote" | "fallback" | null>(null);
  const [modelDiscoveryWarning, setModelDiscoveryWarning] = useState<string | null>(null);
  const [chatPrompt, setChatPrompt] = useState("Say hello from OpenAI-compatible chat completions.");
  const [chatPromptPresetId, setChatPromptPresetId] = useState("hello");
  const [chatUseMemory, setChatUseMemory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [allowlistPreset, setAllowlistPreset] = useState("strict");
  const [chatResponse, setChatResponse] = useState("");
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const [changeReview, setChangeReview] = useState<{
    overall: "safe" | "warning" | "critical";
    items: Array<{ field: string; level: "safe" | "warning" | "critical"; hint?: string }>;
  }>({
    overall: "safe",
    items: [],
  });
  const [error, setError] = useState<string | null>(null);
  const riskDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);
  const providerSecretAbortRef = useRef<AbortController | null>(null);
  const modelPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelPreviewAbortRef = useRef<AbortController | null>(null);
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    reload: reloadProviderCatalog,
  } = useProviderModelCatalog("system");

  const providerOptions = useMemo(
    () =>
      runtimeProviderCatalog.map((provider) => ({
        providerId: provider.providerId,
        label: provider.label,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        resolvedApiStyle: provider.resolvedApiStyle,
        defaultModel: provider.defaultModel,
        apiKeySource: provider.apiKeySource as "none" | "keychain" | "env" | "inline" | undefined,
        apiKeyRef: provider.apiKeyRef,
      })),
    [runtimeProviderCatalog],
  );
  const knownProviderIds = useMemo(() => {
    return new Set(providerOptions.map((provider) => provider.providerId.toLowerCase()));
  }, [providerOptions]);
  const providerSelectOptions = useMemo<SelectOption[]>(() => {
    const fromSettings = providerOptions.map((provider) => ({
      value: provider.providerId,
      label: `${provider.providerId} (${provider.baseUrl})`,
    }));
    const fromTemplates = providerTemplates.map((template) => ({
      value: template.providerId,
      label: `${template.providerId} (${template.baseUrl})`,
    }));
    return [...fromSettings, ...fromTemplates];
  }, [providerOptions]);

  const effectiveActiveProviderId = activeProviderId.trim() || settings?.llm.activeProviderId || "";
  const effectiveProviderId = providerId.trim() || effectiveActiveProviderId;
  const currentProviderRuntime = useMemo(
    () => runtimeProviderCatalog.find((provider) => provider.providerId === effectiveProviderId),
    [effectiveProviderId, runtimeProviderCatalog],
  );
  const providerConfigMap = useMemo(
    () =>
      new Map((runtimeLlmConfig?.providerConfigs ?? []).map((provider) => [provider.providerId, provider] as const)),
    [runtimeLlmConfig?.providerConfigs],
  );
  const providerRequestValidation = useMemo(() => {
    try {
      return {
        request: requestConfigFromDraft(providerRequestDraft),
        error: null,
      };
    } catch (error) {
      return {
        request: undefined,
        error: (error as Error).message,
      };
    }
  }, [providerRequestDraft]);
  const visibleSectionIds = useMemo(() => {
    return activeTab ? new Set(resolveSettingsTabSections(activeTab)) : null;
  }, [activeTab]);
  const showSectionRail = !activeTab;
  const shouldRenderSection = (sectionId: SettingsSectionId) => !visibleSectionIds || visibleSectionIds.has(sectionId);
  const {
    voiceStatus,
    voiceRuntime,
    voiceTalkSessions,
    voiceBusy,
    voiceTalkMode,
    setVoiceTalkMode,
    voiceFile,
    setVoiceFile,
    voiceTranscriptResult,
    voiceActionInfo,
    voiceRecoveryActions,
    voiceOperatorGuidance,
    installedVoiceModelIds,
    refreshVoiceRuntime,
    onInstallManagedVoiceRuntime,
    onSelectManagedVoiceModel,
    onRemoveManagedVoiceModel,
    onStartVoiceTalk,
    onStopVoiceTalk,
    onStartWake,
    onStopWake,
    onRunVoiceTranscribeTest,
  } = useSettingsVoiceRuntime({ setError });

  useEffect(() => {
    if (!focusSectionId || activeTab || typeof window === "undefined") {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      scrollToSettingsSection(focusSectionId, "auto");
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeTab, focusSectionId]);

  const activeModelOptions = useMemo<SelectOption[]>(() => {
    return buildProviderScopedModelOptions({
      providerId: effectiveActiveProviderId,
      providers: runtimeProviderCatalog,
      previewedProviderId,
      previewedModels: models.map((model) => model.id),
      currentModel: activeModel,
      fallbackModel: effectiveActiveProviderId === effectiveProviderId ? providerDefaultModel : undefined,
    });
  }, [
    activeModel,
    effectiveActiveProviderId,
    effectiveProviderId,
    models,
    previewedProviderId,
    providerDefaultModel,
    runtimeProviderCatalog,
  ]);

  const providerDefaultModelOptions = useMemo<SelectOption[]>(() => {
    return buildProviderScopedModelOptions({
      providerId: effectiveProviderId,
      providers: runtimeProviderCatalog,
      previewedProviderId,
      previewedModels: models.map((model) => model.id),
      currentModel: providerDefaultModel,
    });
  }, [effectiveProviderId, models, previewedProviderId, providerDefaultModel, runtimeProviderCatalog]);

  const providerLabelOptions = useMemo<SelectOption[]>(() => {
    const builtins = providerTemplates.map((template) => ({
      value: template.label,
      label: template.label,
    }));
    const existing = providerOptions.map((provider) => ({
      value: provider.label,
      label: provider.label,
    }));
    return [...builtins, ...existing];
  }, [providerOptions]);

  const load = (options: { preserveModelDrafts?: boolean } = {}) => {
    const preserveModelDrafts = options.preserveModelDrafts ?? false;
    void fetchSettings()
      .then((raw) => {
        const res = normalizeRuntimeSettingsResponse(raw);
        const hydrateDrafts = resolveModelDraftHydration(
          preserveModelDrafts,
          hasUnsavedActiveLlmDraft,
          hasUnsavedProviderDraft,
        );
        setSettings(res);
        setDeploymentProfile(res.deploymentProfile);
        setProfile(res.defaultToolProfile);
        setBudgetMode((res.budgetMode as "saver" | "balanced" | "power") || "balanced");
        setReadAccessMode(res.readAccessMode ?? "roots_only");
        setNetworkAllowlistText(res.networkAllowlist.join("\n"));
        setAllowlistPreset(matchAllowlistPreset(res.networkAllowlist));
        setFirecrawlEnabled(res.web.firecrawl.enabled);
        setFirecrawlBaseUrl(res.web.firecrawl.baseUrl);
        setFirecrawlApiKeyEnv(res.web.firecrawl.apiKeyEnv ?? "FIRECRAWL_API_KEY");
        setFirecrawlTimeoutMs(res.web.firecrawl.timeoutMs);
        setFirecrawlDefaultReadBackend(res.web.firecrawl.defaultReadBackend);
        setFirecrawlFallbackToNative(res.web.firecrawl.fallbackToNative);
        setAuthMode(res.auth.mode);
        setAllowLoopbackBypass(res.auth.allowLoopbackBypass);

        if (hydrateDrafts.activeSelection) {
          setActiveProviderId(res.llm.activeProviderId);
          setActiveModel(res.llm.activeModel);
        }

        if (hydrateDrafts.providerEditor) {
          setProviderId(res.llm.activeProviderId);

          const activeProvider = res.llm.providers.find((provider) => provider.providerId === res.llm.activeProviderId);
          if (activeProvider) {
            setProviderLabel(activeProvider.label);
            setProviderBaseUrl(activeProvider.baseUrl);
            setProviderApiStyle(activeProvider.apiStyle);
            setProviderDefaultModel(activeProvider.defaultModel);
            setProviderApiKeyEnv(
              activeProvider.apiKeySource === "env" && activeProvider.apiKeyRef ? activeProvider.apiKeyRef : "",
            );
          }
          setProviderRequestDraft(createEmptyLlmTransportDraft());
        }

        if (!preserveModelDrafts) {
          setHasUnsavedActiveLlmDraft(false);
          setHasUnsavedProviderDraft(false);
        }

        setChatPromptPresetId("hello");
        hydrateStoredAuthCredentials();
      })
      .catch((err: Error) => setError(err.message));
    void fetchDeviceAccessGrants("all")
      .then((res) => setDeviceGrants(res.items))
      .catch(() => setDeviceGrants([]));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!runtimeLlmConfig) {
      return;
    }
    setSettings((current) => (current ? { ...current, llm: runtimeLlmConfig } : current));
  }, [runtimeLlmConfig]);

  useEffect(() => {
    if (hasUnsavedProviderDraft) {
      return;
    }
    const config = providerConfigMap.get(providerId.trim());
    setProviderRequestDraft(draftFromRequestConfig(config?.request));
  }, [hasUnsavedProviderDraft, providerConfigMap, providerId]);

  useRefreshSubscription(
    "system",
    async (signal) => {
      const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
      if (
        !/\b(onboarding|settings|auth|device)\b/.test(haystack) &&
        signal.eventType !== "fallback_poll" &&
        signal.reason !== "replay_gap"
      ) {
        return;
      }
      load({ preserveModelDrafts: true });
    },
    {
      enabled: true,
      coalesceMs: 900,
      staleMs: 20000,
      pollIntervalMs: 20000,
    },
  );

  const onRevokeDeviceGrant = async (grantId: string) => {
    setDeviceGrantBusyId(grantId);
    try {
      const response = await revokeDeviceAccessGrant(grantId);
      setDeviceGrants((current) =>
        current.map((item) => (item.grantId === response.grant.grantId ? response.grant : item)),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeviceGrantBusyId(null);
    }
  };

  useEffect(() => {
    if (!settings) {
      return;
    }
    if (riskDebounceRef.current) {
      clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    const changes = [
      { field: "deploymentProfile", from: settings.deploymentProfile, to: deploymentProfile },
      { field: "defaultToolProfile", from: settings.defaultToolProfile, to: profile },
      { field: "budgetMode", from: settings.budgetMode, to: budgetMode },
      { field: "readAccessMode", from: settings.readAccessMode ?? "roots_only", to: readAccessMode },
      { field: "networkAllowlist", from: settings.networkAllowlist.join("\n"), to: networkAllowlistText },
      { field: "firecrawlEnabled", from: String(settings.web.firecrawl.enabled), to: String(firecrawlEnabled) },
      { field: "firecrawlBaseUrl", from: settings.web.firecrawl.baseUrl, to: firecrawlBaseUrl },
      { field: "authMode", from: settings.auth.mode, to: authMode },
      {
        field: "providerBaseUrl",
        from: settings.llm.providers.find((p) => p.providerId === providerId)?.baseUrl ?? "",
        to: providerBaseUrl,
      },
    ];
    riskDebounceRef.current = setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "settings",
          changes,
        },
        { signal: controller.signal },
      )
        .then((res) => {
          setChangeReview({
            overall: res.overall,
            items: res.items.map((item) => ({
              field: item.field,
              level: item.level,
              hint: item.hint,
            })),
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setChangeReview({
            overall: "warning",
            items: [
              {
                field: "settings",
                level: "warning",
                hint: "Unable to load server risk hints.",
              },
            ],
          });
        });
    }, 400);
    return () => {
      if (riskDebounceRef.current) {
        clearTimeout(riskDebounceRef.current);
        riskDebounceRef.current = null;
      }
      riskAbortRef.current?.abort();
    };
  }, [
    settings,
    deploymentProfile,
    profile,
    budgetMode,
    readAccessMode,
    networkAllowlistText,
    firecrawlEnabled,
    firecrawlBaseUrl,
    authMode,
    providerId,
    providerBaseUrl,
  ]);

  useEffect(() => {
    providerSecretAbortRef.current?.abort();
    const normalized = providerId.trim();
    const key = normalized.toLowerCase();
    if (!normalized || key === "custom" || !knownProviderIds.has(key)) {
      setProviderSecretStatus(null);
      return;
    }
    const controller = new AbortController();
    providerSecretAbortRef.current = controller;
    void fetchProviderSecretStatus(normalized, { signal: controller.signal })
      .then((status) => setProviderSecretStatus(status))
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          return;
        }
        setProviderSecretStatus(null);
      });
    return () => {
      controller.abort();
    };
  }, [providerId, knownProviderIds]);

  const onSaveRuntime = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving.");
      return;
    }
    setError(null);
    try {
      const allowlist = networkAllowlistText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const next = await patchSettings({
        deploymentProfile,
        defaultToolProfile: profile,
        budgetMode,
        readAccessMode,
        networkAllowlist: allowlist,
        web: {
          firecrawl: {
            enabled: firecrawlEnabled,
            baseUrl: firecrawlBaseUrl.trim(),
            apiKeyEnv: firecrawlApiKeyEnv.trim() || undefined,
            timeoutMs: firecrawlTimeoutMs,
            defaultReadBackend: firecrawlDefaultReadBackend,
            fallbackToNative: firecrawlFallbackToNative,
          },
        },
      });
      setSettings(normalizeRuntimeSettingsResponse(next));
      await reloadProviderCatalog();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSaveActiveLlm = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving.");
      return;
    }
    setError(null);
    try {
      const next = await patchSettings({
        llm: {
          activeProviderId,
          activeModel,
        },
      });
      setSettings(normalizeRuntimeSettingsResponse(next));
      setHasUnsavedActiveLlmDraft(false);
      await reloadProviderCatalog();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSaveProvider = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving.");
      return;
    }
    if (providerRequestValidation.error) {
      setError(providerRequestValidation.error);
      return;
    }
    setError(null);
    try {
      const next = await patchSettings({
        llm: {
          upsertProvider: {
            providerId,
            label: providerLabel || undefined,
            baseUrl: providerBaseUrl || undefined,
            apiStyle: providerApiStyle,
            defaultModel: providerDefaultModel || undefined,
            apiKeyEnv: providerApiKeyEnv || undefined,
            request: providerRequestValidation.request,
          },
        },
      });
      setSettings(normalizeRuntimeSettingsResponse(next));
      setHasUnsavedProviderDraft(false);
      await reloadProviderCatalog();
      if (providerApiKey.trim()) {
        const status = await saveProviderSecret(providerId, providerApiKey.trim());
        setProviderSecretStatus(status);
        setProviderApiKey("");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSaveProviderKeyToSecureStore = async () => {
    const trimmed = providerApiKey.trim();
    if (!trimmed) {
      setError("Enter a provider API key first.");
      return;
    }
    setError(null);
    try {
      const status = await saveProviderSecret(providerId, trimmed);
      setProviderSecretStatus(status);
      setProviderApiKey("");
      const next = await fetchSettings();
      setSettings(normalizeRuntimeSettingsResponse(next));
      await reloadProviderCatalog();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onDeleteProviderKeyFromSecureStore = async () => {
    setError(null);
    try {
      const status = await deleteProviderSecret(providerId);
      setProviderSecretStatus(status);
      const next = await fetchSettings();
      setSettings(normalizeRuntimeSettingsResponse(next));
      await reloadProviderCatalog();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onLoadModels = async (options: { signal?: AbortSignal; clearError?: boolean } = {}) => {
    if (options.clearError) {
      setError(null);
    }
    try {
      const targetProviderId = (providerId || activeProviderId).trim();
      const targetBaseUrl = providerBaseUrl.trim();
      if (!targetProviderId || !targetBaseUrl) {
        setModels([]);
        setPreviewedProviderId("");
        setModelDiscoverySource(null);
        setModelDiscoveryWarning(null);
        return;
      }
      if (providerRequestValidation.error) {
        setModels([]);
        setPreviewedProviderId(targetProviderId);
        setModelDiscoverySource("fallback");
        setModelDiscoveryWarning(providerRequestValidation.error);
        return;
      }
      setLoadingModels(true);
      setPreviewedProviderId(targetProviderId);
      const res = await previewProviderModels(
        {
          providerId: targetProviderId,
          baseUrl: targetBaseUrl,
          apiStyle: providerApiStyle,
          apiKey: providerApiKey.trim() || undefined,
          apiKeyEnv: providerApiKeyEnv.trim() || undefined,
          request: providerRequestValidation.request,
          fallbackModel: getModelPreviewFallbackModel(
            targetProviderId === effectiveActiveProviderId ? activeModel : "",
            providerDefaultModel,
          ),
        },
        {
          signal: options.signal,
        },
      );
      setModels(res.items.map((id) => ({ id })));
      setModelDiscoverySource(res.source);
      setModelDiscoveryWarning(res.warning ?? null);
      const firstModel = res.items[0];
      if (firstModel && targetProviderId === effectiveActiveProviderId && !activeModel.trim()) {
        setActiveModel(firstModel);
      }
      if (firstModel && !providerDefaultModel.trim()) {
        setProviderDefaultModel(firstModel);
      }
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      setError((err as Error).message);
      setModelDiscoverySource("fallback");
      setModelDiscoveryWarning((err as Error).message);
    } finally {
      if (!options.signal?.aborted) {
        setLoadingModels(false);
      }
    }
  };

  useEffect(() => {
    if (modelPreviewTimerRef.current) {
      clearTimeout(modelPreviewTimerRef.current);
      modelPreviewTimerRef.current = null;
    }
    modelPreviewAbortRef.current?.abort();
    const targetProviderId = (providerId || activeProviderId).trim();
    if (!targetProviderId || !providerBaseUrl.trim()) {
      setLoadingModels(false);
      return;
    }
    modelPreviewTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      modelPreviewAbortRef.current = controller;
      void onLoadModels({ signal: controller.signal }).finally(() => {
        if (modelPreviewAbortRef.current === controller) {
          modelPreviewAbortRef.current = null;
        }
      });
    }, 600);
    return () => {
      if (modelPreviewTimerRef.current) {
        clearTimeout(modelPreviewTimerRef.current);
        modelPreviewTimerRef.current = null;
      }
      modelPreviewAbortRef.current?.abort();
    };
  }, [
    activeProviderId,
    providerApiKey,
    providerApiKeyEnv,
    providerApiStyle,
    providerBaseUrl,
    providerId,
    providerRequestValidation.error,
    providerRequestValidation.request,
  ]);

  const onTestChat = async () => {
    setError(null);
    try {
      const res = await createLlmChatCompletion({
        providerId: activeProviderId || undefined,
        model: activeModel || undefined,
        messages: [{ role: "user", content: chatPrompt }],
        memory: chatUseMemory ? { mode: "qmd", enabled: true } : { mode: "off", enabled: false },
      });
      const text = res.choices?.[0]?.message?.content;
      if (typeof text === "string") {
        setChatResponse(text);
      } else {
        setChatResponse(JSON.stringify(res, null, 2));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const hydrateStoredAuthCredentials = () => {
    const stored = readStoredGatewayAuthState();
    if (!stored) {
      setAuthStorageMode(getGatewayAuthStorageMode());
      return;
    }
    setAuthToken(stored.token ?? "");
    setBasicUsername(stored.username ?? "");
    setBasicPassword(stored.password ?? "");
    setAuthStorageMode(getGatewayAuthStorageMode());
  };

  const onSaveAuth = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving.");
      return;
    }
    setError(null);
    try {
      const next = await patchSettings({
        auth: {
          mode: authMode,
          allowLoopbackBypass,
          token: authToken,
          basicUsername: basicUsername,
          basicPassword: basicPassword,
        },
      });
      setSettings(normalizeRuntimeSettingsResponse(next));
      const nextStorageMode = resolveAuthStorageMode(authMode, authStorageMode === "persistent");
      if (authMode === "none") {
        clearGatewayAuthState();
        setGatewayAuthStorageMode(nextStorageMode);
        setAuthStorageMode(nextStorageMode);
        return;
      }
      setGatewayAuthStorageMode(nextStorageMode);
      setAuthStorageMode(nextStorageMode);
      persistGatewayAuthState(
        {
          mode: authMode,
          token: authToken,
          username: basicUsername,
          password: basicPassword,
        },
        nextStorageMode,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyProviderTemplate = (nextProviderId: string) => {
    const current = providerOptions.find((provider) => provider.providerId === nextProviderId);
    const template = providerTemplates.find((item) => item.providerId === nextProviderId);
    const currentConfig = providerConfigMap.get(nextProviderId);

    if (current) {
      setProviderLabel(current.label);
      setProviderBaseUrl(current.baseUrl);
      setProviderApiStyle(current.apiStyle);
      setProviderDefaultModel(current.defaultModel);
      setProviderApiKeyEnv(current.apiKeySource === "env" ? (current.apiKeyRef ?? "") : "");
      setProviderApiKey("");
      setProviderRequestDraft(draftFromRequestConfig(currentConfig?.request));
      return;
    }

    if (template) {
      setProviderLabel(template.label);
      setProviderBaseUrl(template.baseUrl);
      setProviderApiStyle(template.apiStyle ?? "openai-chat-completions");
      setProviderDefaultModel(template.defaultModel);
      setProviderApiKeyEnv("");
      setProviderApiKey("");
      setProviderRequestDraft(draftFromRequestConfig(currentConfig?.request));
    }
  };

  const selectPreferredProviderModel = (nextProviderId: string) => {
    setActiveModel((current) => resolveProviderModelSelection(nextProviderId, runtimeProviderCatalog, current));
  };

  const applyLocalProviderPreset = (nextProviderId: "lmstudio" | "ollama") => {
    const template = providerTemplates.find((item) => item.providerId === nextProviderId);
    if (!template) {
      return;
    }
    setActiveProviderId(nextProviderId);
    setActiveModel(template.defaultModel);
    setProviderId(nextProviderId);
    setProviderLabel(template.label);
    setProviderBaseUrl(template.baseUrl);
    setProviderApiStyle(template.apiStyle ?? "openai-chat-completions");
    setProviderDefaultModel(template.defaultModel);
    setProviderApiKey("");
    setProviderApiKeyEnv("");
    setProviderRequestDraft(draftFromRequestConfig(providerConfigMap.get(nextProviderId)?.request));
    setHasUnsavedActiveLlmDraft(true);
    setHasUnsavedProviderDraft(true);
    setShowAdvanced(true);
  };

  const blockSaves = changeReview.overall === "critical" && !criticalConfirmed;

  if (!settings) {
    return <p>Loading Forge settings...</p>;
  }

  return (
    <section>
      <PageHeader
        eyebrow="Configuration"
        title={pageCopy.settings.title}
        subtitle={pageCopy.settings.subtitle}
        hint="Tune providers, access, and runtime defaults without leaving Mission Control."
        className="page-header-command settings-header"
      />
      <PageGuideCard
        pageId="settings"
        what={pageCopy.settings.guide?.what ?? ""}
        when={pageCopy.settings.guide?.when ?? ""}
        actions={pageCopy.settings.guide?.actions ?? []}
        terms={pageCopy.settings.guide?.terms}
      />
      {error ? <p className="error">{error}</p> : null}
      <ChangeReviewPanel
        title="Pending Configuration Risk"
        overall={changeReview.overall}
        items={changeReview.items}
        requireCriticalConfirm
        criticalConfirmed={criticalConfirmed}
        onCriticalConfirmChange={setCriticalConfirmed}
      />

      <div className={`settings-v2-layout${showSectionRail ? "" : " settings-v2-layout-single"}`}>
        {showSectionRail ? (
          <SettingsSectionNav sections={SETTINGS_SECTIONS} onNavigate={scrollToSettingsSection} />
        ) : null}

        <div className="settings-v2-content">
          {shouldRenderSection("settings-overview") ? (
            <SettingsOverviewSection
              environment={settings.environment}
              workspaceDir={settings.workspaceDir}
              deploymentProfile={deploymentProfile}
              authMode={authMode}
              activeProviderId={activeProviderId}
              fallbackProviderId={settings.llm.activeProviderId}
              activeModel={activeModel}
              fallbackModel={settings.llm.activeModel}
              allowLoopbackBypass={allowLoopbackBypass}
            />
          ) : null}

          {shouldRenderSection("settings-access") ? (
            <SettingsAccessSection
              authMode={authMode}
              onAuthModeChange={setAuthMode}
              allowLoopbackBypass={allowLoopbackBypass}
              onAllowLoopbackBypassChange={setAllowLoopbackBypass}
              authStorageMode={authStorageMode}
              onAuthStorageModeChange={setAuthStorageMode}
              authToken={authToken}
              onAuthTokenChange={setAuthToken}
              basicUsername={basicUsername}
              onBasicUsernameChange={setBasicUsername}
              basicPassword={basicPassword}
              onBasicPasswordChange={setBasicPassword}
              tokenConfigured={settings.auth.tokenConfigured}
              basicConfigured={settings.auth.basicConfigured}
              onSaveAuth={onSaveAuth}
              blockSaves={blockSaves}
              deviceGrants={deviceGrants}
              deviceGrantBusyId={deviceGrantBusyId}
              onRevokeDeviceGrant={onRevokeDeviceGrant}
            />
          ) : null}

          {shouldRenderSection("settings-voice") ? (
            <SettingsVoiceSection
              voiceStatus={voiceStatus}
              voiceRuntime={voiceRuntime}
              voiceTalkSessions={voiceTalkSessions}
              voiceActionInfo={voiceActionInfo}
              voiceOperatorGuidance={voiceOperatorGuidance}
              voiceRecoveryActions={voiceRecoveryActions}
              voiceBusy={voiceBusy}
              installedVoiceModelIds={installedVoiceModelIds}
              voiceTalkMode={voiceTalkMode}
              onVoiceTalkModeChange={setVoiceTalkMode}
              voiceFile={voiceFile}
              onVoiceFileChange={setVoiceFile}
              voiceTranscriptResult={voiceTranscriptResult}
              onInstallManagedVoiceRuntime={onInstallManagedVoiceRuntime}
              onSelectManagedVoiceModel={onSelectManagedVoiceModel}
              onRemoveManagedVoiceModel={onRemoveManagedVoiceModel}
              onStartVoiceTalk={onStartVoiceTalk}
              onStopVoiceTalk={onStopVoiceTalk}
              onStartWake={onStartWake}
              onStopWake={onStopWake}
              onRunVoiceTranscribeTest={onRunVoiceTranscribeTest}
              refreshVoiceRuntime={refreshVoiceRuntime}
            />
          ) : null}

          {shouldRenderSection("settings-runtime") ? (
            <SettingsRuntimeSection
              deploymentProfile={deploymentProfile}
              onDeploymentProfileChange={setDeploymentProfile}
              profile={profile}
              onProfileChange={setProfile}
              toolProfileOptions={TOOL_PROFILE_OPTIONS}
              budgetMode={budgetMode}
              onBudgetModeChange={setBudgetMode}
              readAccessMode={readAccessMode}
              onReadAccessModeChange={setReadAccessMode}
              readAccessModeOptions={READ_ACCESS_MODE_OPTIONS}
              allowlistPreset={allowlistPreset}
              onAllowlistPresetChange={(nextPreset) => {
                setAllowlistPreset(nextPreset);
                const preset = ALLOWLIST_PRESETS.find((item) => item.id === nextPreset);
                if (preset) {
                  setNetworkAllowlistText(preset.hosts.join("\n"));
                }
              }}
              allowlistPresets={ALLOWLIST_PRESETS}
              networkAllowlistText={networkAllowlistText}
              onNetworkAllowlistTextChange={(value) => {
                setAllowlistPreset("custom");
                setNetworkAllowlistText(value);
              }}
              firecrawlEnabled={firecrawlEnabled}
              onFirecrawlEnabledChange={setFirecrawlEnabled}
              firecrawlDefaultReadBackend={firecrawlDefaultReadBackend}
              onFirecrawlDefaultReadBackendChange={setFirecrawlDefaultReadBackend}
              firecrawlDefaultReadBackendOptions={FIRECRAWL_DEFAULT_READ_BACKEND_OPTIONS}
              firecrawlBaseUrl={firecrawlBaseUrl}
              onFirecrawlBaseUrlChange={setFirecrawlBaseUrl}
              firecrawlApiKeyEnv={firecrawlApiKeyEnv}
              onFirecrawlApiKeyEnvChange={setFirecrawlApiKeyEnv}
              firecrawlTimeoutMs={firecrawlTimeoutMs}
              onFirecrawlTimeoutMsChange={setFirecrawlTimeoutMs}
              firecrawlFallbackToNative={firecrawlFallbackToNative}
              onFirecrawlFallbackToNativeChange={setFirecrawlFallbackToNative}
              onSaveRuntime={onSaveRuntime}
              blockSaves={blockSaves}
            />
          ) : null}

          {shouldRenderSection("settings-models") ? (
            <SettingsModelsSection
              applyLocalProviderPreset={applyLocalProviderPreset}
              activeProviderId={activeProviderId}
              onActiveProviderIdChange={(nextProviderId) => {
                setHasUnsavedActiveLlmDraft(true);
                setHasUnsavedProviderDraft(true);
                setActiveProviderId(nextProviderId);
                setProviderId(nextProviderId);
                applyProviderTemplate(nextProviderId);
                selectPreferredProviderModel(nextProviderId);
              }}
              providerSelectOptions={providerSelectOptions}
              activeModel={activeModel}
              onActiveModelChange={(nextModel) => {
                setHasUnsavedActiveLlmDraft(true);
                setActiveModel(nextModel);
              }}
              activeModelOptions={activeModelOptions}
              loadingModels={loadingModels}
              onLoadModels={() => {
                void onLoadModels({ clearError: true });
              }}
              modelDiscoverySource={modelDiscoverySource}
              modelDiscoveryWarning={modelDiscoveryWarning}
              models={models}
              onSaveActiveLlm={onSaveActiveLlm}
              blockSaves={blockSaves}
              showAdvanced={showAdvanced}
              onToggleAdvanced={() => setShowAdvanced((current) => !current)}
              providerId={providerId}
              onProviderIdChange={(nextProviderId) => {
                setHasUnsavedProviderDraft(true);
                setProviderId(nextProviderId);
                applyProviderTemplate(nextProviderId);
              }}
              providerLabel={providerLabel}
              onProviderLabelChange={(nextLabel) => {
                setHasUnsavedProviderDraft(true);
                setProviderLabel(nextLabel);
              }}
              providerLabelOptions={providerLabelOptions}
              providerBaseUrl={providerBaseUrl}
              onProviderBaseUrlChange={(nextBaseUrl) => {
                setHasUnsavedProviderDraft(true);
                setProviderBaseUrl(nextBaseUrl);
              }}
              providerTemplates={providerTemplates}
              providerApiStyle={providerApiStyle}
              onProviderApiStyleChange={(nextApiStyle) => {
                setHasUnsavedProviderDraft(true);
                setProviderApiStyle(nextApiStyle);
              }}
              providerApiStyleOptions={PROVIDER_API_STYLE_OPTIONS}
              currentProviderRuntime={currentProviderRuntime}
              providerDefaultModel={providerDefaultModel}
              onProviderDefaultModelChange={(nextDefaultModel) => {
                setHasUnsavedProviderDraft(true);
                setProviderDefaultModel(nextDefaultModel);
              }}
              providerDefaultModelOptions={providerDefaultModelOptions}
              providerApiKey={providerApiKey}
              onProviderApiKeyChange={(nextApiKey) => {
                setHasUnsavedProviderDraft(true);
                setProviderApiKey(nextApiKey);
              }}
              providerSecretStatus={providerSecretStatus}
              providerOptions={providerOptions}
              onSaveProviderKeyToSecureStore={onSaveProviderKeyToSecureStore}
              onDeleteProviderKeyFromSecureStore={onDeleteProviderKeyFromSecureStore}
              providerApiKeyEnv={providerApiKeyEnv}
              onProviderApiKeyEnvChange={(nextApiKeyEnv) => {
                setHasUnsavedProviderDraft(true);
                setProviderApiKeyEnv(nextApiKeyEnv);
              }}
              providerRequestDraft={providerRequestDraft}
              onProviderRequestDraftChange={(nextDraft) => {
                setHasUnsavedProviderDraft(true);
                setProviderRequestDraft(nextDraft);
              }}
              providerRequestValidationError={providerRequestValidation.error}
              onSaveProvider={onSaveProvider}
            />
          ) : null}

          {shouldRenderSection("settings-tests") ? (
            <SettingsTestsSection
              chatPromptPresetId={chatPromptPresetId}
              onChatPromptPresetIdChange={setChatPromptPresetId}
              chatPromptPresets={CHAT_PROMPT_PRESETS}
              chatPrompt={chatPrompt}
              onChatPromptChange={setChatPrompt}
              chatUseMemory={chatUseMemory}
              onChatUseMemoryChange={setChatUseMemory}
              chatResponse={chatResponse}
              onTestChat={onTestChat}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
export {
  buildProviderScopedModelOptions,
  getModelPreviewFallbackModel,
  matchAllowlistPreset,
  resolveAuthStorageMode,
  resolveModelDraftHydration,
  resolveProviderModelSelection,
  type ProviderScopedModelOptionSource,
} from "./settings/settings-page-helpers";
