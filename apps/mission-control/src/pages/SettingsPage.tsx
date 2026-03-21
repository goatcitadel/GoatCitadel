import { useEffect, useMemo, useRef, useState } from "react";
import { providerTemplates } from "@goatcitadel/contracts";
import {
  clearGatewayAuthState,
  createLlmChatCompletion,
  deleteProviderSecret,
  evaluateUiChangeRisk,
  getGatewayAuthStorageMode,
  persistGatewayAuthState,
  readStoredGatewayAuthState,
  fetchVoiceStatus,
  fetchVoiceRuntimeStatus,
  fetchProviderSecretStatus,
  fetchSettings,
  installVoiceRuntime,
  patchSettings,
  removeVoiceRuntimeModel,
  saveProviderSecret,
  selectVoiceRuntimeModel,
  setGatewayAuthStorageMode,
  startVoiceTalkSession,
  startVoiceWake,
  stopVoiceTalkSession,
  stopVoiceWake,
  transcribeVoice,
  type GatewayAuthStorageMode,
  type ProviderSecretStatus,
  type RuntimeSettingsResponse,
} from "../api/client";
import type { VoiceRuntimeStatus, VoiceStatus } from "@goatcitadel/contracts";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { FieldHelp } from "../components/FieldHelp";
import { HelpHint } from "../components/HelpHint";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { SelectOrCustom, type SelectOption } from "../components/SelectOrCustom";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch } from "../components/ui";
import { pageCopy } from "../content/copy";
import { dedupeProviderModels, previewProviderModels, useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

const TOOL_PROFILE_OPTIONS: SelectOption[] = [
  { value: "minimal", label: "minimal (safest)" },
  { value: "standard", label: "standard" },
  { value: "coding", label: "coding" },
  { value: "ops", label: "ops" },
  { value: "research", label: "research" },
  { value: "danger", label: "danger (high risk)" },
];

const READ_ACCESS_MODE_OPTIONS: SelectOption[] = [
  { value: "roots_only", label: "trusted roots only" },
  { value: "approval_required", label: "ask before outside-root reads" },
  { value: "full_disk", label: "full disk read access" },
];

const ALLOWLIST_PRESETS: Array<{ id: string; label: string; hosts: string[] }> = [
  { id: "strict", label: "Strict (no outbound hosts)", hosts: [] },
  { id: "local", label: "Local models only", hosts: ["127.0.0.1", "localhost"] },
  {
    id: "web-research",
    label: "Web research (browser tools + local)",
    hosts: [
      "127.0.0.1",
      "localhost",
      "*.duckduckgo.com",
      "*.google.com",
      "*.bing.com",
      "*.wikipedia.org",
      "*.github.com",
      "*.developer.mozilla.org",
    ],
  },
  {
    id: "common-llm",
    label: "Common providers + local",
    hosts: ["127.0.0.1", "localhost", "api.openai.com", "openrouter.ai"],
  },
  {
    id: "tailnet-genie",
    label: "Tailnet + Genie IR20",
    hosts: ["127.0.0.1", "localhost", "100.64.0.4", "ir20"],
  },
];

const CHAT_PROMPT_PRESETS: Array<{ id: string; label: string; prompt: string }> = [
  { id: "hello", label: "Hello smoke test", prompt: "Say hello from OpenAI-compatible chat completions." },
  {
    id: "plan",
    label: "Planning response",
    prompt: "In 5 bullets, propose a safe implementation plan for a new feature.",
  },
  {
    id: "safety",
    label: "Safety check",
    prompt: "Summarize one policy risk and one mitigation for executing a risky shell command.",
  },
];

const SETTINGS_SECTIONS = [
  {
    id: "settings-overview",
    label: "Overview",
    description: "Environment, defaults, and runtime posture.",
  },
  {
    id: "settings-access",
    label: "Access",
    description: "Auth mode, loopback behavior, and credential storage.",
  },
  {
    id: "settings-voice",
    label: "Voice",
    description: "Talk mode, wake runtime, and local transcription.",
  },
  {
    id: "settings-runtime",
    label: "Runtime",
    description: "Tool profile, budgets, and outbound allowlist.",
  },
  {
    id: "settings-models",
    label: "Models",
    description: "Providers, active model selection, and secure keys.",
  },
  {
    id: "settings-tests",
    label: "Test",
    description: "Run a direct provider smoke test before wider use.",
  },
] as const;

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function scrollToSettingsSection(sectionId: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SettingsPage() {
  const [settings, setSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [deploymentProfile, setDeploymentProfile] = useState<"local_dev" | "trusted_local" | "remote_hardened">("local_dev");
  const [profile, setProfile] = useState("");
  const [budgetMode, setBudgetMode] = useState<"saver" | "balanced" | "power">("balanced");
  const [readAccessMode, setReadAccessMode] = useState<"roots_only" | "approval_required" | "full_disk">("roots_only");
  const [networkAllowlistText, setNetworkAllowlistText] = useState("");

  const [activeProviderId, setActiveProviderId] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [providerId, setProviderId] = useState("custom");
  const [providerLabel, setProviderLabel] = useState("Custom");
  const [providerBaseUrl, setProviderBaseUrl] = useState("http://127.0.0.1:1234/v1");
  const [providerDefaultModel, setProviderDefaultModel] = useState("local-model");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerApiKeyEnv, setProviderApiKeyEnv] = useState("");
  const [providerSecretStatus, setProviderSecretStatus] = useState<ProviderSecretStatus | null>(null);
  const [hasUnsavedActiveLlmDraft, setHasUnsavedActiveLlmDraft] = useState(false);
  const [hasUnsavedProviderDraft, setHasUnsavedProviderDraft] = useState(false);
  const [authMode, setAuthMode] = useState<"none" | "token" | "basic">("none");
  const [allowLoopbackBypass, setAllowLoopbackBypass] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [basicPassword, setBasicPassword] = useState("");
  const [authStorageMode, setAuthStorageMode] = useState<GatewayAuthStorageMode>("session");
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
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceTalkMode, setVoiceTalkMode] = useState<"push_to_talk" | "wake">("push_to_talk");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceTranscriptResult, setVoiceTranscriptResult] = useState("");
  const [voiceActionInfo, setVoiceActionInfo] = useState("");
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

  const providerOptions = useMemo(() => runtimeProviderCatalog.map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKeySource: provider.apiKeySource as "none" | "keychain" | "env" | "inline" | undefined,
    apiKeyRef: provider.apiKeyRef,
  })), [runtimeProviderCatalog]);
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
      .then((res) => {
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
            setProviderDefaultModel(activeProvider.defaultModel);
            setProviderApiKeyEnv(activeProvider.apiKeySource === "env" && activeProvider.apiKeyRef ? activeProvider.apiKeyRef : "");
          }
        }

        if (!preserveModelDrafts) {
          setHasUnsavedActiveLlmDraft(false);
          setHasUnsavedProviderDraft(false);
        }

        setChatPromptPresetId("hello");
        hydrateStoredAuthCredentials();
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!runtimeLlmConfig) {
      return;
    }
    setSettings((current) => current ? { ...current, llm: runtimeLlmConfig } : current);
  }, [runtimeLlmConfig]);

  useRefreshSubscription(
    "system",
    async (signal) => {
      const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
      if (!/\b(onboarding|settings)\b/.test(haystack) && signal.eventType !== "fallback_poll") {
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

  useEffect(() => {
    void Promise.all([fetchVoiceStatus(), fetchVoiceRuntimeStatus()])
      .then(([status, runtime]) => {
        setVoiceStatus(status);
        setVoiceRuntime(runtime);
        if (status.talk.mode) {
          setVoiceTalkMode(status.talk.mode);
        }
      })
      .catch(() => {
        setVoiceStatus(null);
        setVoiceRuntime(null);
      });
  }, []);

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
      { field: "authMode", from: settings.auth.mode, to: authMode },
      { field: "providerBaseUrl", from: settings.llm.providers.find((p) => p.providerId === providerId)?.baseUrl ?? "", to: providerBaseUrl },
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
            items: [{
              field: "settings",
              level: "warning",
              hint: "Unable to load server risk hints.",
            }],
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
  }, [settings, deploymentProfile, profile, budgetMode, readAccessMode, networkAllowlistText, authMode, providerId, providerBaseUrl]);

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
      });
      setSettings(next);
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
      setSettings(next);
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
    setError(null);
    try {
      const next = await patchSettings({
        llm: {
          upsertProvider: {
            providerId,
            label: providerLabel || undefined,
            baseUrl: providerBaseUrl || undefined,
            defaultModel: providerDefaultModel || undefined,
            apiKeyEnv: providerApiKeyEnv || undefined,
          },
        },
      });
      setSettings(next);
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
      setSettings(next);
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
      setSettings(next);
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
      setLoadingModels(true);
      setPreviewedProviderId(targetProviderId);
      const res = await previewProviderModels({
        providerId: targetProviderId,
        baseUrl: targetBaseUrl,
        apiKey: providerApiKey.trim() || undefined,
        apiKeyEnv: providerApiKeyEnv.trim() || undefined,
        fallbackModel: getModelPreviewFallbackModel(
          targetProviderId === effectiveActiveProviderId ? activeModel : "",
          providerDefaultModel,
        ),
      }, {
        signal: options.signal,
      });
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
  }, [activeProviderId, providerApiKey, providerApiKeyEnv, providerBaseUrl, providerId]);

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

  const refreshVoiceRuntime = async () => {
    const [status, runtime] = await Promise.all([
      fetchVoiceStatus(),
      fetchVoiceRuntimeStatus(),
    ]);
    setVoiceStatus(status);
    setVoiceRuntime(runtime);
    if (status.talk.mode) {
      setVoiceTalkMode(status.talk.mode);
    }
  };

  const onInstallManagedVoiceRuntime = async (modelId?: string, activate = true) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await installVoiceRuntime({
        modelId,
        activate,
      });
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(
        runtime.readiness === "ready"
          ? `Managed voice runtime is ready${runtime.selectedModelId ? ` with ${runtime.selectedModelId}` : ""}.`
          : "Managed voice runtime was updated, but it still needs attention.",
      );
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onSelectManagedVoiceModel = async (modelId: string) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await selectVoiceRuntimeModel(modelId);
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Activated local voice model ${modelId}.`);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onRemoveManagedVoiceModel = async (modelId: string) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await removeVoiceRuntimeModel(modelId);
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Removed local voice model ${modelId}.`);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStartVoiceTalk = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await startVoiceTalkSession({ mode: voiceTalkMode });
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Talk Mode started (${formatTalkModeLabel(voiceTalkMode)}).`);
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStopVoiceTalk = async () => {
    if (!voiceStatus?.talk.activeSessionId) {
      return;
    }
    setVoiceBusy(true);
    setError(null);
    try {
      await stopVoiceTalkSession(voiceStatus.talk.activeSessionId);
      await refreshVoiceRuntime();
      setVoiceActionInfo("Talk Mode stopped.");
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStartWake = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await startVoiceWake();
      await refreshVoiceRuntime();
      setVoiceActionInfo("Wake listener enabled.");
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStopWake = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await stopVoiceWake();
      await refreshVoiceRuntime();
      setVoiceActionInfo("Wake listener disabled.");
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onRunVoiceTranscribeTest = async () => {
    if (!voiceFile) {
      setError("Choose an audio file first.");
      return;
    }
    setVoiceBusy(true);
    setError(null);
    try {
      const bytesBase64 = await fileToBase64(voiceFile);
      const result = await transcribeVoice({
        bytesBase64,
        mimeType: voiceFile.type || "audio/wav",
      });
      setVoiceTranscriptResult(result.text);
      await refreshVoiceRuntime();
      setVoiceActionInfo(
        `Transcription completed with ${result.provider}${typeof result.durationMs === "number" ? ` in ${result.durationMs}ms` : ""}.`,
      );
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
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
      setSettings(next);
      const nextStorageMode = resolveAuthStorageMode(authMode, authStorageMode === "persistent");
      if (authMode === "none") {
        clearGatewayAuthState();
        setGatewayAuthStorageMode(nextStorageMode);
        setAuthStorageMode(nextStorageMode);
        return;
      }
      setGatewayAuthStorageMode(nextStorageMode);
      setAuthStorageMode(nextStorageMode);
      persistGatewayAuthState({
        mode: authMode,
        token: authToken,
        username: basicUsername,
        password: basicPassword,
      }, nextStorageMode);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyProviderTemplate = (nextProviderId: string) => {
    const current = providerOptions.find((provider) => provider.providerId === nextProviderId);
    const template = providerTemplates.find((item) => item.providerId === nextProviderId);

    if (current) {
      setProviderLabel(current.label);
      setProviderBaseUrl(current.baseUrl);
      setProviderDefaultModel(current.defaultModel);
      setProviderApiKeyEnv(current.apiKeySource === "env" ? (current.apiKeyRef ?? "") : "");
      setProviderApiKey("");
      return;
    }

    if (template) {
      setProviderLabel(template.label);
      setProviderBaseUrl(template.baseUrl);
      setProviderDefaultModel(template.defaultModel);
      setProviderApiKeyEnv("");
      setProviderApiKey("");
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
    setProviderDefaultModel(template.defaultModel);
    setProviderApiKey("");
    setProviderApiKeyEnv("");
    setHasUnsavedActiveLlmDraft(true);
    setHasUnsavedProviderDraft(true);
    setShowAdvanced(true);
  };

  if (!settings) {
    return <p>Loading Forge settings...</p>;
  }

  const blockSaves = changeReview.overall === "critical" && !criticalConfirmed;
  const installedVoiceModelIds = new Set(voiceRuntime?.installedModels.map((item) => item.modelId) ?? []);

  return (
    <section>
      <PageHeader
        eyebrow="Configuration"
        title={pageCopy.settings.title}
        subtitle={pageCopy.settings.subtitle}
        hint="Use Forge to tune providers, safety defaults, and runtime behavior without leaving Mission Control."
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

      <div className="settings-v2-layout">
        <aside className="panel panel-soft panel-pad-default settings-v2-nav">
          <div className="settings-v2-nav-head">
            <h3>Forge Sections</h3>
            <FieldHelp>Jump straight to the part of Forge you need. This keeps long configuration work chunked instead of forcing one giant scroll.</FieldHelp>
          </div>
          <div className="settings-v2-nav-list">
            {SETTINGS_SECTIONS.map((section) => (
              <button key={section.id} type="button" className="settings-v2-nav-item" onClick={() => scrollToSettingsSection(section.id)}>
                <strong>{section.label}</strong>
                <span>{section.description}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="settings-v2-content">
          <section id="settings-overview" className="settings-v2-section">
            <Panel
              title="Current Forge Posture"
              subtitle="Quick context before you touch access, runtime, or provider settings."
              tone="soft"
            >
              <div className="settings-v2-summary">
                <StatusChip tone="muted">{settings.environment}</StatusChip>
                <StatusChip tone={deploymentProfile === "remote_hardened" ? "warning" : deploymentProfile === "trusted_local" ? "success" : "muted"}>
                  {formatDeploymentProfileLabel(deploymentProfile)}
                </StatusChip>
                <StatusChip tone={authMode === "none" ? "warning" : "success"}>{authMode === "none" ? "Local-trusted auth" : `${authMode} auth`}</StatusChip>
                <StatusChip tone="live">{activeProviderId || settings.llm.activeProviderId || "No active provider"}</StatusChip>
                <StatusChip tone={allowLoopbackBypass ? "warning" : "success"}>{allowLoopbackBypass ? "Loopback bypass on" : "Loopback bypass off"}</StatusChip>
              </div>
              <FieldHelp>Environment and workspace values come from the running gateway. Use the section rail to jump directly to access, runtime, providers, or local voice tools.</FieldHelp>
              <div className="settings-v2-overview-grid">
                <div>
                  <strong>Environment</strong>
                  <p className="office-subtitle">{settings.environment}</p>
                </div>
                <div>
                  <strong>Deployment profile</strong>
                  <p className="office-subtitle">{formatDeploymentProfileLabel(deploymentProfile)}</p>
                </div>
                <div>
                  <strong>Workspace</strong>
                  <p className="office-subtitle">{settings.workspaceDir}</p>
                </div>
                <div>
                  <strong>Active provider</strong>
                  <p className="office-subtitle">{activeProviderId || settings.llm.activeProviderId || "not set"}</p>
                </div>
                <div>
                  <strong>Active model</strong>
                  <p className="office-subtitle">{activeModel || settings.llm.activeModel || "not set"}</p>
                </div>
              </div>
            </Panel>
          </section>

          <section id="settings-access" className="settings-v2-section">
            <Panel
              className="settings-v2-panel"
              title="Gateway Access Control"
              subtitle="Use auth modes for local and online hosting. By default, credentials stay session-only and clear when you close the browser."
            >
              <FieldHelp>Keep this section conservative for public or remote installs. Session-only storage is the safer default; persistent storage is a convenience tradeoff.</FieldHelp>
              <div className="controls-row">
                <label htmlFor="authMode">Auth Mode</label>
                <GCSelect
                  id="authMode"
                  value={authMode}
                  onChange={(value) => setAuthMode(value as "none" | "token" | "basic")}
                  options={[
                    { value: "none", label: "none (local trusted)" },
                    { value: "token", label: "token" },
                    { value: "basic", label: "basic" },
                  ]}
                />
              </div>
              <div className="controls-row">
                <GCSwitch
                  id="allowLoopbackBypass"
                  checked={allowLoopbackBypass}
                  onCheckedChange={setAllowLoopbackBypass}
                  label="Allow loopback bypass"
                />
              </div>
              {authMode !== "none" ? (
                <div className="controls-row">
                  <GCSwitch
                    id="authRememberMe"
                    checked={authStorageMode === "persistent"}
                    onCheckedChange={(checked) => setAuthStorageMode(checked ? "persistent" : "session")}
                    label="Remember credentials on this browser (less secure)"
                  />
                </div>
              ) : null}
              {authMode === "token" ? (
                <div className="controls-row">
                  <label htmlFor="authToken">Gateway token</label>
                  <input
                    id="authToken"
                    type="password"
                    value={authToken}
                    onChange={(event) => setAuthToken(event.target.value)}
                  />
                </div>
              ) : null}
              {authMode === "basic" ? (
                <>
                  <div className="controls-row">
                    <label htmlFor="basicUsername">Username</label>
                    <input
                      id="basicUsername"
                      value={basicUsername}
                      onChange={(event) => setBasicUsername(event.target.value)}
                    />
                  </div>
                  <div className="controls-row">
                    <label htmlFor="basicPassword">Password</label>
                    <input
                      id="basicPassword"
                      type="password"
                      value={basicPassword}
                      onChange={(event) => setBasicPassword(event.target.value)}
                    />
                  </div>
                </>
              ) : null}
              <p className="office-subtitle">
                Server status: token configured: {settings.auth.tokenConfigured ? "yes" : "no"} | basic configured: {settings.auth.basicConfigured ? "yes" : "no"}
              </p>
              <button type="button" onClick={onSaveAuth} disabled={blockSaves}>Save Access Control</button>
            </Panel>
          </section>

          <section id="settings-voice" className="settings-v2-section">
            <Panel
              className="settings-v2-panel"
              title="Voice Runtime"
              subtitle={(
                <>
                  Local-first voice controls with no required cloud API key.
                  {" "}
                  <HelpHint label="Voice runtime help" text="Talk Mode and Wake use your local voice runtime. Whisper.cpp is the default offline transcription provider." />
                </>
              )}
            >
        <FieldHelp>Voice tools are local-first and best treated like a hardware/runtime surface: inspect state first, then run talk, wake, or transcription tests intentionally.</FieldHelp>
        <div className="voice-status-grid">
          <article className="voice-status-card">
            <h4>Speech To Text</h4>
            <p><strong>Provider:</strong> {voiceStatus?.stt.provider ?? "unknown"}</p>
            <p><strong>State:</strong> {voiceStatus?.stt.state ?? "unknown"}</p>
            <p><strong>Managed runtime:</strong> {voiceStatus?.stt.runtimeReady ? "ready" : "not ready"}</p>
            <p><strong>Active model:</strong> {voiceStatus?.stt.modelId ?? "none"}</p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.stt.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.stt.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Talk Mode</h4>
            <p><strong>State:</strong> {voiceStatus?.talk.state ?? "unknown"}</p>
            <p><strong>Mode:</strong> {formatTalkModeLabel(voiceStatus?.talk.mode)}</p>
            <p><strong>Active session:</strong> {voiceStatus?.talk.activeSessionId ?? "none"}</p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.talk.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.talk.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Wake Listener</h4>
            <p><strong>Enabled:</strong> {voiceStatus?.wake.enabled ? "yes" : "no"}</p>
            <p><strong>State:</strong> {voiceStatus?.wake.state ?? "unknown"}</p>
            <p><strong>Model:</strong> {voiceStatus?.wake.model ?? "unknown"}</p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.wake.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.wake.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Managed Runtime</h4>
            <p><strong>Readiness:</strong> {describeVoiceRuntimeReadiness(voiceRuntime?.readiness)}</p>
            <p><strong>Source:</strong> {voiceRuntime?.source ?? "unknown"}</p>
            <p><strong>Binary:</strong> {voiceRuntime?.binaryReady ? "ready" : "missing"}</p>
            <p><strong>Audio helper:</strong> {voiceRuntime?.ffmpegReady ? "ready" : "missing"}</p>
            <p className="table-subtext">
              {voiceRuntime?.selectedModelId
                ? `Selected model: ${voiceRuntime.selectedModelId}`
                : "No managed model selected yet."}
            </p>
            {voiceRuntime?.binaryPath ? (
              <p className="table-subtext">Binary path: {voiceRuntime.binaryPath}</p>
            ) : null}
          </article>
        </div>
        {voiceStatus?.stt.lastError ? (
          <p className="error">Last STT error: {voiceStatus.stt.lastError}</p>
        ) : null}
        {voiceRuntime?.lastError ? (
          <p className="error">Last runtime error: {voiceRuntime.lastError}</p>
        ) : null}
        {voiceActionInfo ? <p className="status-banner">{voiceActionInfo}</p> : null}
        <article className="voice-help-card">
          <h4>Managed Voice Runtime</h4>
          <ul className="voice-help-list">
            <li><strong>Install / Repair Voice Runtime:</strong> Downloads or repairs the managed whisper.cpp runtime, the audio normalization helper, and a selected starter model.</li>
            <li><strong>Download model:</strong> Adds another local whisper model without changing the active one.</li>
            <li><strong>Activate model:</strong> Switches GoatCitadel to use that installed model for local transcription.</li>
            <li><strong>Remove model:</strong> Deletes an inactive installed model from your local GoatCitadel home.</li>
            <li><strong>Start Talk Mode:</strong> Creates a talk session and begins live listening flow using the selected mode.</li>
            <li><strong>Stop Talk Mode:</strong> Stops the current talk session and clears active session state.</li>
            <li><strong>Enable Wake:</strong> Turns on wake-word listener mode (for hands-free trigger workflows).</li>
            <li><strong>Disable Wake:</strong> Turns wake-word listener off immediately.</li>
            <li><strong>Refresh Voice Status:</strong> Re-reads current runtime status from gateway without changing state.</li>
            <li><strong>Run Local Transcription:</strong> Uploads your selected audio file for one-shot local STT test.</li>
          </ul>
          <p className="office-subtitle">
            GoatCitadel now manages whisper.cpp locally by default. Advanced overrides like <code>GOATCITADEL_WHISPER_CPP_BIN</code> and <code>GOATCITADEL_WHISPER_CPP_MODEL_PATH</code> are still available for custom setups.
          </p>
        </article>
        <div className="controls-row">
          <button
            type="button"
            onClick={() => void onInstallManagedVoiceRuntime(voiceRuntime?.selectedModelId ?? "base.en", true)}
            disabled={voiceBusy}
          >
            {voiceRuntime?.readiness === "ready" ? "Repair Voice Runtime" : "Install Voice Runtime"}
          </button>
          <button type="button" onClick={() => void refreshVoiceRuntime()} disabled={voiceBusy}>
            Refresh Voice Status
          </button>
        </div>
        <div className="voice-model-catalog">
          {(voiceRuntime?.catalog ?? []).map((model) => {
            const installed = installedVoiceModelIds.has(model.id);
            const active = voiceRuntime?.selectedModelId === model.id;
            return (
              <article key={model.id} className="voice-model-card">
                <div className="voice-model-card__head">
                  <div>
                    <h4>{model.label}</h4>
                    <p className="table-subtext">
                      {formatVoiceLanguageScope(model.languageScope)} | {model.approxSizeLabel}
                    </p>
                  </div>
                  <div className="voice-model-card__badges">
                    {model.recommended ? <StatusChip tone="live">Recommended</StatusChip> : null}
                    {model.defaultInstall ? <StatusChip tone="muted">Starter</StatusChip> : null}
                    {installed ? <StatusChip tone="success">Installed</StatusChip> : <StatusChip tone="warning">Available</StatusChip>}
                    {active ? <StatusChip tone="live">Active</StatusChip> : null}
                  </div>
                </div>
                <div className="voice-model-card__actions">
                  {!installed ? (
                    <button
                      type="button"
                      onClick={() => void onInstallManagedVoiceRuntime(model.id, false)}
                      disabled={voiceBusy}
                    >
                      Download model
                    </button>
                  ) : null}
                  {installed && !active ? (
                    <button
                      type="button"
                      onClick={() => void onSelectManagedVoiceModel(model.id)}
                      disabled={voiceBusy}
                    >
                      Activate model
                    </button>
                  ) : null}
                  {installed && !active ? (
                    <button
                      type="button"
                      onClick={() => void onRemoveManagedVoiceModel(model.id)}
                      disabled={voiceBusy}
                    >
                      Remove model
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        <div className="controls-row">
          <label htmlFor="voiceTalkMode">Talk mode</label>
          <GCSelect
            id="voiceTalkMode"
            value={voiceTalkMode}
            onChange={(value) => setVoiceTalkMode(value as "push_to_talk" | "wake")}
            options={[
              { value: "push_to_talk", label: "Push to talk" },
              { value: "wake", label: "Wake triggered" },
            ]}
          />
          <button type="button" onClick={onStartVoiceTalk} disabled={voiceBusy || voiceStatus?.talk.state === "running"}>
            Start Talk Mode
          </button>
          <button type="button" onClick={onStopVoiceTalk} disabled={voiceBusy || voiceStatus?.talk.state !== "running"}>
            Stop Talk Mode
          </button>
        </div>
        <div className="controls-row">
          <button type="button" onClick={onStartWake} disabled={voiceBusy || voiceStatus?.wake.enabled}>
            Enable Wake
          </button>
          <button type="button" onClick={onStopWake} disabled={voiceBusy || !voiceStatus?.wake.enabled}>
            Disable Wake
          </button>
        </div>
        <div className="controls-row">
          <label htmlFor="voiceTestFile">Transcription test file</label>
          <input
            id="voiceTestFile"
            type="file"
            accept="audio/*"
            onChange={(event) => setVoiceFile(event.target.files?.[0] ?? null)}
          />
          <button type="button" onClick={onRunVoiceTranscribeTest} disabled={voiceBusy || !voiceFile}>
            Run Local Transcription
          </button>
        </div>
        {voiceTranscriptResult ? (
          <pre>{voiceTranscriptResult}</pre>
        ) : null}
            </Panel>
          </section>

          <section id="settings-runtime" className="settings-v2-section">
            <Panel
              className="settings-v2-panel"
              title="Runtime Controls"
              subtitle="Tune how boldly GoatCitadel acts by default before you change providers, tools, or outbound access."
            >
        <FieldHelp>Runtime controls shape how boldly GoatCitadel acts by default. Use the allowlist preset first, then drop into custom mode only when your network or model layout needs it.</FieldHelp>
        <div className="controls-row">
          <label htmlFor="deploymentProfile">
            Deployment Profile
            <HelpHint label="Deployment profile help" text="local_dev is loose for iteration, trusted_local enables browser state tools on a trusted machine, and remote_hardened requires explicit auth and tighter confirmation flows." />
          </label>
          <GCSelect
            id="deploymentProfile"
            value={deploymentProfile}
            onChange={(value) => setDeploymentProfile(value as "local_dev" | "trusted_local" | "remote_hardened")}
            options={[
              { value: "local_dev", label: "local_dev" },
              { value: "trusted_local", label: "trusted_local" },
              { value: "remote_hardened", label: "remote_hardened" },
            ]}
          />
        </div>
        {deploymentProfile === "remote_hardened" ? (
          <FieldHelp>
            Hardened mode fails closed unless auth is enabled, loopback bypass stays off, outbound hosts are explicitly allowlisted, and browser submit flows include verification plus confirm-before-submit.
          </FieldHelp>
        ) : null}
        <div className="controls-row">
          <label htmlFor="profile">Tool Profile</label>
          <SelectOrCustom
            id="profile"
            value={profile}
            onChange={setProfile}
            options={TOOL_PROFILE_OPTIONS}
            customPlaceholder="Custom tool profile"
            customLabel="Custom profile"
          />
        </div>
        <div className="controls-row">
          <label htmlFor="budgetMode">Budget Mode</label>
          <GCSelect
            id="budgetMode"
            value={budgetMode}
            onChange={(value) => setBudgetMode(value as "saver" | "balanced" | "power")}
            options={[
              { value: "saver", label: "saver" },
              { value: "balanced", label: "balanced" },
              { value: "power", label: "power" },
            ]}
          />
        </div>
        <details className="advanced-panel">
          <summary>Advanced runtime options</summary>
          <div className="controls-row">
            <label htmlFor="readAccessMode">Filesystem Read Access</label>
            <GCSelect
              id="readAccessMode"
              value={readAccessMode}
              onChange={(value) => setReadAccessMode(value as "roots_only" | "approval_required" | "full_disk")}
              options={READ_ACCESS_MODE_OPTIONS}
            />
          </div>
          <FieldHelp>
            `trusted roots only` keeps reads inside the configured workspace and skills roots. `ask before outside-root reads` turns out-of-root local file reads into approval prompts in chat. `full disk read access` skips those prompts. Prompt Lab still bootstraps its own read grants for evaluation runs.
          </FieldHelp>
          <div className="controls-row">
            <label htmlFor="allowlistPreset">Allowlist Preset <HelpHint label="Network allowlist help" text="This controls outbound hosts GoatCitadel is allowed to contact. It is not your machine's LAN IP. Use local hosts for local models, and provider domains such as api.z.ai for cloud models." /></label>
            <GCSelect
              id="allowlistPreset"
              value={allowlistPreset}
              onChange={(nextPreset) => {
                setAllowlistPreset(nextPreset);
                const preset = ALLOWLIST_PRESETS.find((item) => item.id === nextPreset);
                if (preset) {
                  setNetworkAllowlistText(preset.hosts.join("\n"));
                }
              }}
              options={[
                ...ALLOWLIST_PRESETS.map((preset) => ({
                  value: preset.id,
                  label: preset.label,
                })),
                { value: "custom", label: "custom" },
              ]}
            />
          </div>
          <label htmlFor="allowlist">Network Allowlist (one host/pattern per line)</label>
          <textarea
            id="allowlist"
            rows={6}
            className="full-textarea"
            value={networkAllowlistText}
            onChange={(event) => {
              setAllowlistPreset("custom");
              setNetworkAllowlistText(event.target.value);
            }}
          />
        </details>
        <button type="button" onClick={onSaveRuntime} disabled={blockSaves}>Save Runtime Controls</button>
            </Panel>
          </section>

          <section id="settings-models" className="settings-v2-section">
            <Panel
              className="settings-v2-panel"
              title="LLM Providers & Models (OpenAI-Compatible)"
              subtitle="This uses /v1/chat/completions only. Legacy /v1/completions is intentionally not used."
            >
        <FieldHelp>Pick an active provider and model first, then use the advanced block only when you need to add or override provider details. Known values should stay in selects; custom entry is the fallback.</FieldHelp>
        <details className="advanced-panel">
          <summary>Local runtime quick setup: LM Studio + Ollama</summary>
          <p className="office-subtitle"><strong>LM Studio:</strong> load at least one model, then start its local server.</p>
          <p className="office-subtitle">Base URL: <code>http://127.0.0.1:1234/v1</code> | model id: the loaded model name in LM Studio.</p>
          <p className="office-subtitle"><strong>Ollama:</strong> run <code>ollama pull llama3.2</code> and keep Ollama running.</p>
          <p className="office-subtitle">Base URL: <code>http://127.0.0.1:11434/v1</code> | model id: installed tag, for example <code>llama3.2</code>.</p>
          <p className="office-subtitle">If GoatCitadel is remote, replace <code>127.0.0.1</code> with the host IP/tailnet name and include that host in your outbound allowlist.</p>
          <div className="controls-row">
            <button type="button" onClick={() => applyLocalProviderPreset("lmstudio")}>Use LM Studio Preset</button>
            <button type="button" onClick={() => applyLocalProviderPreset("ollama")}>Use Ollama Preset</button>
          </div>
        </details>

        <div className="controls-row">
          <label htmlFor="activeProvider">Active Provider <HelpHint label="Active provider help" text="The active provider is the company or endpoint GoatCitadel will use for new chats and tests by default." /></label>
          <SelectOrCustom
            id="activeProvider"
            value={activeProviderId}
            onChange={(nextProviderId) => {
              setHasUnsavedActiveLlmDraft(true);
              setHasUnsavedProviderDraft(true);
              setActiveProviderId(nextProviderId);
              setProviderId(nextProviderId);
              applyProviderTemplate(nextProviderId);
              selectPreferredProviderModel(nextProviderId);
            }}
            options={providerSelectOptions}
            customPlaceholder="Custom provider id"
            customLabel="Custom active provider"
          />
        </div>

        <div className="controls-row">
          <label htmlFor="activeModel">Active Model <HelpHint label="Active model help" text="This is the actual model GoatCitadel will send prompts to for the active provider. The list below is discovered live when possible so you can pick a working model instead of guessing." /></label>
          <SelectOrCustom
            id="activeModel"
            value={activeModel}
            onChange={(nextModel) => {
              setHasUnsavedActiveLlmDraft(true);
              setActiveModel(nextModel);
            }}
            options={activeModelOptions}
            customPlaceholder="Custom model id"
            customLabel="Custom active model"
          />
          <button type="button" onClick={() => { void onLoadModels({ clearError: true }); }}>{loadingModels ? "Loading..." : "Refresh Models"}</button>
        </div>
        {modelDiscoverySource ? (
          <p className="office-subtitle">
            Model discovery: {modelDiscoverySource === "remote" ? "live provider list" : "fallback/default list"}
            {modelDiscoveryWarning ? ` · ${modelDiscoveryWarning}` : ""}
          </p>
        ) : null}
        {models.length > 0 ? (
          <ul className="compact-list">
            {models.map((model) => (
              <li key={model.id}>{model.id}</li>
            ))}
          </ul>
        ) : null}
        <button type="button" onClick={onSaveActiveLlm} disabled={blockSaves}>Save Active Provider/Model</button>

        <button type="button" onClick={() => setShowAdvanced((current) => !current)}>
          {showAdvanced ? "Hide advanced provider settings" : "Show advanced provider settings"}
        </button>
        {showAdvanced ? (
          <div className="advanced-block">
            <h4>Add / Update Provider</h4>
            <div className="controls-row">
              <label htmlFor="providerId">Provider ID <HelpHint label="Provider ID help" text="Provider ID is GoatCitadel's stable machine name for this endpoint, such as glm or moonshot. It is how runtime settings and chats refer to the provider internally." /></label>
              <SelectOrCustom
                id="providerId"
                value={providerId}
                onChange={(nextProviderId) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderId(nextProviderId);
                  applyProviderTemplate(nextProviderId);
                }}
                options={providerSelectOptions}
                customPlaceholder="e.g. corp-gateway"
                customLabel="Custom provider id"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerLabel">Label <HelpHint label="Provider label help" text="Label is the human-readable display name shown in the UI. It does not have to match the provider ID exactly." /></label>
              <SelectOrCustom
                id="providerLabel"
                value={providerLabel}
                onChange={(nextLabel) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderLabel(nextLabel);
                }}
                options={providerLabelOptions}
                customPlaceholder="Provider display label"
                customLabel="Custom label"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerBaseUrl">Base URL</label>
              <SelectOrCustom
                id="providerBaseUrl"
                value={providerBaseUrl}
                onChange={(nextBaseUrl) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderBaseUrl(nextBaseUrl);
                }}
                options={providerTemplates.map((template) => ({
                  value: template.baseUrl,
                  label: template.baseUrl,
                }))}
                customPlaceholder="https://host/v1"
                customLabel="Custom base URL"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerDefaultModel">Default Model <HelpHint label="Default model help" text="Default model is the model GoatCitadel should choose first for this provider when a chat or page has not pinned a different model yet." /></label>
              <SelectOrCustom
                id="providerDefaultModel"
                value={providerDefaultModel}
                onChange={(nextDefaultModel) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderDefaultModel(nextDefaultModel);
                }}
                options={providerDefaultModelOptions}
                customPlaceholder="Default model id"
                customLabel="Custom default model"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerApiKey">API Key (optional)</label>
              <input
                id="providerApiKey"
                type="password"
                value={providerApiKey}
                onChange={(event) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderApiKey(event.target.value);
                }}
              />
            </div>
            <p className="office-subtitle">
              Key source: {providerSecretStatus?.source ?? providerOptions.find((provider) => provider.providerId === providerId)?.apiKeySource ?? "none"}
            </p>
            <div className="controls-row">
              <button type="button" onClick={onSaveProviderKeyToSecureStore} disabled={!providerApiKey.trim()}>
                Save Key to Secure Store
              </button>
              <button type="button" onClick={onDeleteProviderKeyFromSecureStore}>
                Remove Secure Key
              </button>
            </div>
            <div className="controls-row">
              <label htmlFor="providerApiKeyEnv">API Key Env (optional) <HelpHint label="Provider API key env help" text="This is the environment variable name GoatCitadel should look for at runtime, for example GLM_API_KEY. It names the variable; it is not the secret value itself." /></label>
              <SelectOrCustom
                id="providerApiKeyEnv"
                value={providerApiKeyEnv}
                onChange={(nextApiKeyEnv) => {
                  setHasUnsavedProviderDraft(true);
                  setProviderApiKeyEnv(nextApiKeyEnv);
                }}
                options={[
                  { value: "OPENAI_API_KEY", label: "OPENAI_API_KEY" },
                  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" },
                  { value: "GOOGLE_API_KEY", label: "GOOGLE_API_KEY" },
                  { value: "GLM_API_KEY", label: "GLM_API_KEY" },
                  { value: "MOONSHOT_API_KEY", label: "MOONSHOT_API_KEY" },
                  { value: "OPENROUTER_API_KEY", label: "OPENROUTER_API_KEY" },
                  { value: "OLLAMA_API_KEY", label: "OLLAMA_API_KEY (optional/proxy only)" },
                  { value: "LMSTUDIO_API_KEY", label: "LMSTUDIO_API_KEY (optional/proxy only)" },
                ]}
                customPlaceholder="Custom env var name"
                customLabel="Custom env var"
              />
            </div>
            <button type="button" onClick={onSaveProvider} disabled={blockSaves}>Save Provider Settings</button>
          </div>
        ) : null}
            </Panel>
          </section>

          <section id="settings-tests" className="settings-v2-section">
            <Panel
              className="settings-v2-panel"
              title="LLM Test (chat/completions)"
              subtitle="Test prompts default to direct model behavior without QMD memory context."
            >
        <FieldHelp>Use test prompts to prove the active provider/model path before you rely on it elsewhere. This is the fastest way to confirm a provider is responding correctly.</FieldHelp>
        <div className="controls-row">
          <label htmlFor="chatPromptPreset">Prompt Preset</label>
          <GCSelect
            id="chatPromptPreset"
            value={chatPromptPresetId}
            onChange={(nextPreset) => {
              setChatPromptPresetId(nextPreset);
              const preset = CHAT_PROMPT_PRESETS.find((item) => item.id === nextPreset);
              if (preset) {
                setChatPrompt(preset.prompt);
              }
            }}
            options={[
              ...CHAT_PROMPT_PRESETS.map((preset) => ({
                value: preset.id,
                label: preset.label,
              })),
              { value: "custom", label: "custom" },
            ]}
          />
        </div>
        <textarea
          rows={4}
          className="full-textarea"
          value={chatPrompt}
          onChange={(event) => setChatPrompt(event.target.value)}
        />
        <div className="controls-row">
          <GCSwitch
            id="chatUseMemory"
            checked={chatUseMemory}
            onCheckedChange={setChatUseMemory}
            label="Include memory context (QMD)"
          />
        </div>
        <div className="controls-row">
          <button type="button" onClick={onTestChat}>Run Test Prompt</button>
        </div>
        {chatResponse ? <pre>{chatResponse}</pre> : null}
            </Panel>
          </section>
        </div>
      </div>
      </section>
  );
}

function describeVoiceState(state?: VoiceStatus["stt"]["state"]): string {
  if (state === "running") {
    return "Runtime is currently active.";
  }
  if (state === "error") {
    return "Runtime hit an error and needs attention.";
  }
  if (state === "stopped") {
    return "Runtime is idle.";
  }
  return "State unknown.";
}

function describeVoiceRuntimeReadiness(readiness?: VoiceRuntimeStatus["readiness"]): string {
  if (readiness === "ready") {
    return "Ready";
  }
  if (readiness === "broken") {
    return "Installed but incomplete";
  }
  if (readiness === "missing") {
    return "Missing";
  }
  return "Unknown";
}

function formatVoiceLanguageScope(scope: VoiceRuntimeStatus["catalog"][number]["languageScope"]): string {
  return scope === "english" ? "English" : "Multilingual";
}

function formatTalkModeLabel(mode?: VoiceStatus["talk"]["mode"]): string {
  if (mode === "push_to_talk") {
    return "Push to talk";
  }
  if (mode === "wake") {
    return "Wake triggered";
  }
  return "Not set";
}

function formatVoiceDate(value?: string): string {
  if (!value) {
    return "-";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

function matchAllowlistPreset(allowlist: string[]): string {
  for (const preset of ALLOWLIST_PRESETS) {
    if (preset.hosts.length !== allowlist.length) {
      continue;
    }
    const left = [...preset.hosts].sort().join("|");
    const right = [...allowlist].sort().join("|");
    if (left === right) {
      return preset.id;
    }
  }
  return "custom";
}

interface ProviderScopedModelOptionSource {
  providerId: string;
  defaultModel: string;
  models: string[];
}

export function buildProviderScopedModelOptions(input: {
  providerId: string;
  providers: ProviderScopedModelOptionSource[];
  previewedProviderId?: string;
  previewedModels?: string[];
  currentModel?: string;
  fallbackModel?: string;
}): SelectOption[] {
  const provider = input.providers.find((item) => item.providerId === input.providerId);
  const previewModels = input.previewedProviderId === input.providerId ? (input.previewedModels ?? []) : [];
  const items = dedupeProviderModels([
    provider?.defaultModel,
    ...(provider?.models ?? []),
    ...previewModels,
    input.fallbackModel,
    input.currentModel,
  ]);
  return items.map((item) => ({ value: item, label: item }));
}

export function getModelPreviewFallbackModel(currentModel: string, providerDefaultModel: string): string | undefined {
  return currentModel.trim() || providerDefaultModel.trim() || undefined;
}

export function resolveModelDraftHydration(
  preserveModelDrafts: boolean,
  hasUnsavedActiveLlmDraft: boolean,
  hasUnsavedProviderDraft: boolean,
): { activeSelection: boolean; providerEditor: boolean } {
  if (!preserveModelDrafts) {
    return {
      activeSelection: true,
      providerEditor: true,
    };
  }
  return {
    activeSelection: !hasUnsavedActiveLlmDraft,
    providerEditor: !hasUnsavedActiveLlmDraft && !hasUnsavedProviderDraft,
  };
}

export function resolveProviderModelSelection(
  providerId: string,
  providers: ProviderScopedModelOptionSource[],
  currentModel: string,
): string {
  const provider = providers.find((item) => item.providerId === providerId);
  const options = dedupeProviderModels([
    provider?.defaultModel,
    ...(provider?.models ?? []),
  ]);
  const normalizedCurrent = currentModel.trim();
  if (normalizedCurrent && options.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return options[0] ?? "";
}

export function resolveAuthStorageMode(
  authMode: "none" | "token" | "basic",
  rememberCredentials: boolean,
): GatewayAuthStorageMode {
  if (authMode === "none") {
    return "session";
  }
  return rememberCredentials ? "persistent" : "session";
}

function formatDeploymentProfileLabel(value: "local_dev" | "trusted_local" | "remote_hardened"): string {
  if (value === "trusted_local") {
    return "trusted_local";
  }
  if (value === "remote_hardened") {
    return "remote_hardened";
  }
  return "local_dev";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unable to read audio file."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Unable to read audio file."));
    reader.readAsDataURL(file);
  });
}

