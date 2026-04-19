/* eslint-disable max-lines -- Onboarding keeps setup state, review, and readiness on one guided page until the flow stabilizes further. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { providerTemplates } from "@goatcitadel/contracts";
import {
  bootstrapOnboarding,
  evaluateUiChangeRisk,
  fetchDaemonStatus,
  fetchOnboardingState,
  resolveGatewayInstallToken,
  restartDaemon,
  startDaemon,
  type RuntimeSettingsResponse,
} from "../api/client";
import { HelpHint } from "../components/HelpHint";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  LlmTransportFields,
  requestConfigFromDraft,
} from "../components/LlmTransportFields";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { SelectOrCustom, type SelectOption } from "../components/SelectOrCustom";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";
import { previewProviderModels, useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { OnboardingProgressPanel } from "./onboarding/OnboardingProgressPanel";
import { OnboardingQuickstartProfilesPanel } from "./onboarding/OnboardingQuickstartProfilesPanel";
import { OnboardingReadinessPanel } from "./onboarding/OnboardingReadinessPanel";
import { OnboardingReviewApplyPanel } from "./onboarding/OnboardingReviewApplyPanel";
import { OnboardingStepNav } from "./onboarding/OnboardingStepNav";
import { OnboardingWizardLayout } from "./onboarding/OnboardingWizardLayout";

const TOOL_PROFILE_OPTIONS: SelectOption[] = [
  { value: "minimal", label: "minimal (safest)" },
  { value: "standard", label: "standard" },
  { value: "coding", label: "coding" },
  { value: "ops", label: "ops" },
  { value: "research", label: "research" },
  { value: "danger", label: "danger (high risk)" },
];

const BUDGET_OPTIONS: Array<RuntimeSettingsResponse["budgetMode"]> = ["saver", "balanced", "power"];
type ProviderApiStyle = RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];

const ALLOWLIST_PRESETS: Array<{ id: string; label: string; hosts: string[] }> = [
  { id: "strict", label: "Strict (none)", hosts: [] },
  { id: "local", label: "Local only", hosts: ["127.0.0.1", "localhost"] },
  {
    id: "web-research",
    label: "Web research + local",
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
  { id: "common", label: "Common cloud + local", hosts: ["127.0.0.1", "localhost", "api.openai.com", "openrouter.ai"] },
];

const STEP_TITLES = [
  "Gateway Access",
  "LLM Provider",
  "Runtime Defaults",
  "Mesh (Optional)",
  "Review & Apply",
] as const;

type OnboardingRuntimeState = Awaited<ReturnType<typeof fetchOnboardingState>>;

const QUICKSTART_PRESETS = [
  {
    id: "solo-local",
    title: "Solo Local",
    summary: "Fastest path for one machine and one operator.",
    apply: () => ({
      authMode: "none" as const,
      allowLoopbackBypass: true,
      defaultToolProfile: "coding",
      budgetMode: "balanced" as const,
      allowlistPreset: "local",
      networkAllowlistText: "127.0.0.1\nlocalhost",
      meshEnabled: false,
      meshMode: "lan" as const,
      meshRequireMtls: true,
      meshTailnetEnabled: false,
    }),
  },
  {
    id: "hybrid-operator",
    title: "Hybrid Operator",
    summary: "Local-first with cloud model access and safer defaults.",
    apply: () => ({
      authMode: "token" as const,
      allowLoopbackBypass: true,
      defaultToolProfile: "coding",
      budgetMode: "balanced" as const,
      allowlistPreset: "common",
      networkAllowlistText: "127.0.0.1\nlocalhost\napi.openai.com\nopenrouter.ai",
      meshEnabled: false,
      meshMode: "lan" as const,
      meshRequireMtls: true,
      meshTailnetEnabled: false,
    }),
  },
  {
    id: "remote-hardened",
    title: "Remote Hardened",
    summary: "Token-gated, explicit outbound hosts, ready for wider exposure.",
    apply: () => ({
      authMode: "token" as const,
      allowLoopbackBypass: false,
      defaultToolProfile: "standard",
      budgetMode: "saver" as const,
      allowlistPreset: "web-research",
      networkAllowlistText:
        "127.0.0.1\nlocalhost\n*.github.com\n*.developer.mozilla.org\napi.openai.com\nopenrouter.ai",
      meshEnabled: false,
      meshMode: "wan" as const,
      meshRequireMtls: true,
      meshTailnetEnabled: false,
    }),
  },
] as const;

type StepId = 0 | 1 | 2 | 3 | 4;

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function readOnboardingActiveProvider(
  state: OnboardingRuntimeState | null,
  providerId: string,
): OnboardingRuntimeState["settings"]["llm"]["providers"][number] | undefined {
  return state?.settings.llm.providers.find((provider) => provider.providerId === providerId);
}

function hasUnsavedOnboardingDraft(params: {
  state: OnboardingRuntimeState | null;
  authMode: "none" | "token" | "basic";
  allowLoopbackBypass: boolean;
  authToken: string;
  basicUsername: string;
  basicPassword: string;
  activeProviderId: string;
  activeModel: string;
  providerLabel: string;
  providerBaseUrl: string;
  providerApiStyle: ProviderApiStyle;
  providerDefaultModel: string;
  providerApiKey: string;
  providerApiKeyEnv: string;
  currentProviderTransportDraftJson: string;
  savedProviderTransportDraftJson: string;
  defaultToolProfile: string;
  budgetMode: RuntimeSettingsResponse["budgetMode"];
  networkAllowlistText: string;
  meshEnabled: boolean;
  meshMode: "lan" | "wan" | "tailnet";
  meshNodeId: string;
  meshMdns: boolean;
  meshStaticPeers: string;
  meshRequireMtls: boolean;
  meshTailnetEnabled: boolean;
  markComplete: boolean;
}): boolean {
  const activeProvider = readOnboardingActiveProvider(params.state, params.activeProviderId);
  return Boolean(
    !params.state ||
    params.authMode !== params.state.settings.auth.mode ||
    params.allowLoopbackBypass !== params.state.settings.auth.allowLoopbackBypass ||
    params.authToken.trim().length > 0 ||
    params.basicUsername.trim().length > 0 ||
    params.basicPassword.length > 0 ||
    params.activeProviderId !== params.state.settings.llm.activeProviderId ||
    params.activeModel !== params.state.settings.llm.activeModel ||
    params.providerLabel !== (activeProvider?.label ?? "") ||
    params.providerBaseUrl !== (activeProvider?.baseUrl ?? "") ||
    params.providerApiStyle !== (activeProvider?.apiStyle ?? "openai-responses") ||
    params.providerDefaultModel !== (activeProvider?.defaultModel ?? "") ||
    params.providerApiKey.trim().length > 0 ||
    params.providerApiKeyEnv !== (activeProvider?.apiKeySource === "env" ? (activeProvider.apiKeyRef ?? "") : "") ||
    params.currentProviderTransportDraftJson !== params.savedProviderTransportDraftJson ||
    params.defaultToolProfile !== params.state.settings.defaultToolProfile ||
    params.budgetMode !== params.state.settings.budgetMode ||
    params.networkAllowlistText !== params.state.settings.networkAllowlist.join("\n") ||
    params.meshEnabled !== params.state.settings.mesh.enabled ||
    params.meshMode !== params.state.settings.mesh.mode ||
    params.meshNodeId !== params.state.settings.mesh.nodeId ||
    params.meshMdns !== params.state.settings.mesh.mdns ||
    params.meshStaticPeers !== params.state.settings.mesh.staticPeers.join("\n") ||
    params.meshRequireMtls !== params.state.settings.mesh.requireMtls ||
    params.meshTailnetEnabled !== params.state.settings.mesh.tailnetEnabled ||
    params.markComplete !== !params.state.completed,
  );
}

export function OnboardingPage({ onCompleted }: { onCompleted?: () => void } = {}) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [step, setStep] = useState<StepId>(0);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<OnboardingRuntimeState | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<Awaited<ReturnType<typeof fetchDaemonStatus>> | null>(null);
  const [daemonBusy, setDaemonBusy] = useState<"start" | "restart" | null>(null);
  const [installTokenInfo, setInstallTokenInfo] = useState<Awaited<
    ReturnType<typeof resolveGatewayInstallToken>
  > | null>(null);
  const [installTokenBusy, setInstallTokenBusy] = useState(false);

  const [authMode, setAuthMode] = useState<"none" | "token" | "basic">("none");
  const [allowLoopbackBypass, setAllowLoopbackBypass] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [basicPassword, setBasicPassword] = useState("");

  const [activeProviderId, setActiveProviderId] = useState("openai");
  const [activeModel, setActiveModel] = useState("gpt-5.4");
  const [providerLabel, setProviderLabel] = useState("OpenAI");
  const [providerBaseUrl, setProviderBaseUrl] = useState("https://api.openai.com/v1");
  const [providerApiStyle, setProviderApiStyle] = useState<ProviderApiStyle>("openai-responses");
  const [providerDefaultModel, setProviderDefaultModel] = useState("gpt-5.4");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerApiKeyEnv, setProviderApiKeyEnv] = useState("");
  const [providerRequestDraft, setProviderRequestDraft] = useState(createEmptyLlmTransportDraft);
  const [savedProviderTransportDraftJson, setSavedProviderTransportDraftJson] = useState(
    JSON.stringify(createEmptyLlmTransportDraft()),
  );
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelDiscoverySource, setModelDiscoverySource] = useState<"remote" | "fallback" | null>(null);
  const [modelDiscoveryWarning, setModelDiscoveryWarning] = useState<string | null>(null);

  const [defaultToolProfile, setDefaultToolProfile] = useState("minimal");
  const [budgetMode, setBudgetMode] = useState<RuntimeSettingsResponse["budgetMode"]>("balanced");
  const [allowlistPreset, setAllowlistPreset] = useState("strict");
  const [networkAllowlistText, setNetworkAllowlistText] = useState("");

  const [meshEnabled, setMeshEnabled] = useState(false);
  const [meshMode, setMeshMode] = useState<"lan" | "wan" | "tailnet">("lan");
  const [meshNodeId, setMeshNodeId] = useState("");
  const [meshMdns, setMeshMdns] = useState(true);
  const [meshStaticPeers, setMeshStaticPeers] = useState("");
  const [meshRequireMtls, setMeshRequireMtls] = useState(true);
  const [meshTailnetEnabled, setMeshTailnetEnabled] = useState(false);

  const [markComplete, setMarkComplete] = useState(true);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const [changeReview, setChangeReview] = useState<{
    overall: "safe" | "warning" | "critical";
    items: Array<{ field: string; level: "safe" | "warning" | "critical"; hint?: string }>;
  }>({
    overall: "safe",
    items: [],
  });
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    reload: reloadProviderCatalog,
  } = useProviderModelCatalog("system");
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const riskDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);
  const hasUnsavedDraftRef = useRef(false);
  const stateRef = useRef<OnboardingRuntimeState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const providerOptions = useMemo<SelectOption[]>(() => {
    const fromState = runtimeProviderCatalog.map((provider) => ({
      value: provider.providerId,
      label: `${provider.providerId} (${provider.baseUrl})`,
    }));
    const fromTemplates = providerTemplates.map((template) => ({
      value: template.providerId,
      label: `${template.providerId} (${template.baseUrl})`,
    }));
    return [...fromState, ...fromTemplates];
  }, [runtimeProviderCatalog]);

  const modelOptions = useMemo<SelectOption[]>(() => {
    const values = [
      activeModel,
      providerDefaultModel,
      ...availableModels,
      ...(runtimeProviderCatalog.map((provider) => provider.defaultModel) ?? []),
      ...providerTemplates.map((template) => template.defaultModel),
    ].filter(Boolean);
    return [...new Set(values)].map((value) => ({ value, label: value }));
  }, [activeModel, availableModels, providerDefaultModel, runtimeProviderCatalog]);

  const providerLabelOptions = useMemo<SelectOption[]>(() => {
    const values = [
      providerLabel,
      ...(state?.settings.llm.providers.map((provider) => provider.label) ?? []),
      ...providerTemplates.map((template) => template.label),
    ].filter(Boolean);
    return [...new Set(values)].map((value) => ({ value, label: value }));
  }, [providerLabel, state]);

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

  const hydrateFromState = useCallback(
    (next: OnboardingRuntimeState) => {
      setAuthMode(next.settings.auth.mode);
      setAllowLoopbackBypass(next.settings.auth.allowLoopbackBypass);
      setDefaultToolProfile(next.settings.defaultToolProfile);
      setBudgetMode(next.settings.budgetMode);
      setNetworkAllowlistText(next.settings.networkAllowlist.join("\n"));
      setAllowlistPreset(matchAllowlistPreset(next.settings.networkAllowlist));

      setActiveProviderId(next.settings.llm.activeProviderId);
      setActiveModel(next.settings.llm.activeModel);
      const activeProvider = next.settings.llm.providers.find(
        (provider) => provider.providerId === next.settings.llm.activeProviderId,
      );
      if (activeProvider) {
        setProviderLabel(activeProvider.label);
        setProviderBaseUrl(activeProvider.baseUrl);
        setProviderApiStyle(activeProvider.apiStyle);
        setProviderDefaultModel(activeProvider.defaultModel);
        setProviderApiKeyEnv(activeProvider.apiKeySource === "env" ? (activeProvider.apiKeyRef ?? "") : "");
      } else {
        setProviderApiKeyEnv("");
      }
      setProviderApiKey("");

      const nextTransportDraft = draftFromRequestConfig(
        providerConfigMap.get(next.settings.llm.activeProviderId)?.request,
      );
      setProviderRequestDraft(nextTransportDraft);
      setSavedProviderTransportDraftJson(JSON.stringify(nextTransportDraft));

      setMeshEnabled(next.settings.mesh.enabled);
      setMeshMode(next.settings.mesh.mode);
      setMeshNodeId(next.settings.mesh.nodeId);
      setMeshMdns(next.settings.mesh.mdns);
      setMeshStaticPeers(next.settings.mesh.staticPeers.join("\n"));
      setMeshRequireMtls(next.settings.mesh.requireMtls);
      setMeshTailnetEnabled(next.settings.mesh.tailnetEnabled);
    },
    [providerConfigMap],
  );

  useEffect(() => {
    if (!state || hasUnsavedDraftRef.current) {
      return;
    }
    const nextTransportDraft = draftFromRequestConfig(providerConfigMap.get(activeProviderId.trim())?.request);
    setProviderRequestDraft(nextTransportDraft);
    setSavedProviderTransportDraftJson(JSON.stringify(nextTransportDraft));
  }, [activeProviderId, providerConfigMap, state]);

  useEffect(() => {
    hasUnsavedDraftRef.current = hasUnsavedOnboardingDraft({
      state,
      authMode,
      allowLoopbackBypass,
      authToken,
      basicUsername,
      basicPassword,
      activeProviderId,
      activeModel,
      providerLabel,
      providerBaseUrl,
      providerApiStyle,
      providerDefaultModel,
      providerApiKey,
      providerApiKeyEnv,
      currentProviderTransportDraftJson: JSON.stringify(providerRequestDraft),
      savedProviderTransportDraftJson,
      defaultToolProfile,
      budgetMode,
      networkAllowlistText,
      meshEnabled,
      meshMode,
      meshNodeId,
      meshMdns,
      meshStaticPeers,
      meshRequireMtls,
      meshTailnetEnabled,
      markComplete,
    });
  }, [
    activeModel,
    activeProviderId,
    allowLoopbackBypass,
    authMode,
    authToken,
    basicPassword,
    basicUsername,
    budgetMode,
    defaultToolProfile,
    markComplete,
    meshEnabled,
    meshMdns,
    meshMode,
    meshNodeId,
    meshRequireMtls,
    meshStaticPeers,
    meshTailnetEnabled,
    networkAllowlistText,
    providerApiKey,
    providerApiKeyEnv,
    providerRequestDraft,
    providerApiStyle,
    providerBaseUrl,
    providerDefaultModel,
    providerLabel,
    savedProviderTransportDraftJson,
    state,
  ]);

  const load = useCallback(
    async (options: { preserveDrafts?: boolean } = {}) => {
      const preserveDrafts = options.preserveDrafts ?? false;
      const shouldBlockRender = !stateRef.current && !preserveDrafts;
      if (shouldBlockRender) {
        setLoading(true);
      }
      setError(null);
      try {
        const next = await fetchOnboardingState();
        setState(next);
        if (!preserveDrafts || !hasUnsavedDraftRef.current) {
          hydrateFromState(next);
        }
        setLoading(false);
        void fetchDaemonStatus()
          .then((daemon) => {
            setDaemonStatus(daemon);
          })
          .catch(() => {
            setDaemonStatus(null);
          });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [hydrateFromState],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!runtimeLlmConfig) {
      return;
    }
    setState((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              llm: runtimeLlmConfig,
            },
          }
        : current,
    );
  }, [runtimeLlmConfig]);

  useEffect(() => {
    if (authMode !== "token") {
      setInstallTokenInfo(null);
    }
  }, [authMode]);

  useRefreshSubscription(
    "system",
    async (signal) => {
      const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
      if (!/\b(onboarding|settings)\b/.test(haystack)) {
        return;
      }
      await load({ preserveDrafts: true });
    },
    {
      enabled: true,
      coalesceMs: 900,
    },
  );

  useEffect(() => {
    if (!state) {
      return;
    }
    if (riskDebounceRef.current) {
      clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    const changes = [
      { field: "authMode", from: state.settings.auth.mode ?? "none", to: authMode },
      { field: "defaultToolProfile", from: state.settings.defaultToolProfile ?? "minimal", to: defaultToolProfile },
      {
        field: "providerBaseUrl",
        from: state.settings.llm.providers.find((p) => p.providerId === activeProviderId)?.baseUrl ?? "",
        to: providerBaseUrl,
      },
      { field: "networkAllowlist", from: state.settings.networkAllowlist.join("\n"), to: networkAllowlistText },
    ];
    riskDebounceRef.current = setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "onboarding",
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
                field: "onboarding",
                level: "warning",
                hint: "Risk preflight unavailable.",
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
  }, [state, authMode, defaultToolProfile, activeProviderId, providerBaseUrl, networkAllowlistText]);

  useEffect(() => {
    const providerId = activeProviderId.trim();
    const baseUrl = providerBaseUrl.trim();
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    previewAbortRef.current?.abort();
    if (!providerId || !baseUrl) {
      setAvailableModels([]);
      setModelDiscoverySource(null);
      setModelDiscoveryWarning(null);
      setLoadingModels(false);
      return;
    }
    if (providerRequestValidation.error) {
      setAvailableModels([]);
      setModelDiscoverySource("fallback");
      setModelDiscoveryWarning(providerRequestValidation.error);
      setLoadingModels(false);
      return;
    }
    previewTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      previewAbortRef.current = controller;
      setLoadingModels(true);
      void previewProviderModels(
        {
          providerId,
          baseUrl,
          apiStyle: providerApiStyle,
          apiKey: providerApiKey.trim() || undefined,
          apiKeyEnv: providerApiKeyEnv.trim() || undefined,
          request: providerRequestValidation.request,
          fallbackModel: providerDefaultModel || activeModel,
        },
        {
          signal: controller.signal,
        },
      )
        .then((result) => {
          setAvailableModels(result.items);
          setModelDiscoverySource(result.source);
          setModelDiscoveryWarning(result.warning ?? null);
          const firstModel = result.items[0];
          if (firstModel && (!activeModel.trim() || !result.items.includes(activeModel))) {
            setActiveModel(firstModel);
          }
          if (firstModel && (!providerDefaultModel.trim() || !result.items.includes(providerDefaultModel))) {
            setProviderDefaultModel(firstModel);
          }
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setModelDiscoverySource("fallback");
          setModelDiscoveryWarning((err as Error).message);
        })
        .finally(() => {
          if (previewAbortRef.current === controller) {
            previewAbortRef.current = null;
          }
          if (!controller.signal.aborted) {
            setLoadingModels(false);
          }
        });
    }, 600);
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      previewAbortRef.current?.abort();
    };
  }, [
    activeModel,
    activeProviderId,
    providerApiKey,
    providerApiKeyEnv,
    providerApiStyle,
    providerBaseUrl,
    providerDefaultModel,
    providerRequestValidation.error,
    providerRequestValidation.request,
  ]);

  const applyProviderTemplate = (providerId: string) => {
    const existing =
      runtimeProviderCatalog.find((provider) => provider.providerId === providerId) ??
      state?.settings.llm.providers.find((provider) => provider.providerId === providerId);
    const template = providerTemplates.find((candidate) => candidate.providerId === providerId);
    const source = existing ?? template;
    if (!source) {
      return;
    }
    setProviderLabel(source.label);
    setProviderBaseUrl(source.baseUrl);
    setProviderApiStyle(source.apiStyle ?? "openai-chat-completions");
    setProviderDefaultModel(source.defaultModel);
    setProviderApiKey("");
    setProviderApiKeyEnv(existing?.apiKeySource === "env" ? (existing.apiKeyRef ?? "") : "");
    setProviderRequestDraft(draftFromRequestConfig(providerConfigMap.get(providerId)?.request));
    if (!activeModel || activeModel === providerDefaultModel) {
      setActiveModel(source.defaultModel);
    }
  };

  const applyAllowlistPreset = (presetId: string) => {
    setAllowlistPreset(presetId);
    const preset = ALLOWLIST_PRESETS.find((item) => item.id === presetId);
    if (preset) {
      setNetworkAllowlistText(preset.hosts.join("\n"));
    }
  };

  const applyQuickstartPreset = (presetId: (typeof QUICKSTART_PRESETS)[number]["id"]) => {
    const preset = QUICKSTART_PRESETS.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    const values = preset.apply();
    setAuthMode(values.authMode);
    setAllowLoopbackBypass(values.allowLoopbackBypass);
    setDefaultToolProfile(values.defaultToolProfile);
    setBudgetMode(values.budgetMode);
    setAllowlistPreset(values.allowlistPreset);
    setNetworkAllowlistText(values.networkAllowlistText);
    setMeshEnabled(values.meshEnabled);
    setMeshMode(values.meshMode);
    setMeshRequireMtls(values.meshRequireMtls);
    setMeshTailnetEnabled(values.meshTailnetEnabled);
    setApplyMessage(`Loaded ${preset.title} defaults. Review provider and credentials before applying.`);
  };

  const handleDaemonAction = async (action: "start" | "restart") => {
    setDaemonBusy(action);
    setError(null);
    try {
      const response = action === "start" ? await startDaemon() : await restartDaemon();
      setDaemonStatus(response.status);
      if (!response.accepted) {
        setError(response.reason);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(null);
    }
  };

  const handleResolveInstallToken = async () => {
    setInstallTokenBusy(true);
    setError(null);
    try {
      const resolved = await resolveGatewayInstallToken({
        generateWhenMissing: true,
        persistToEnv: false,
      });
      setInstallTokenInfo(resolved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstallTokenBusy(false);
    }
  };

  const submit = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before applying onboarding.");
      return;
    }
    if (providerRequestValidation.error) {
      setError(providerRequestValidation.error);
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const bootstrap = await bootstrapOnboarding({
        defaultToolProfile: defaultToolProfile as "minimal" | "standard" | "coding" | "ops" | "research" | "danger",
        budgetMode,
        networkAllowlist: parseMultiline(networkAllowlistText),
        auth: {
          mode: authMode,
          allowLoopbackBypass,
          token: authMode === "token" ? authToken : undefined,
          basicUsername: authMode === "basic" ? basicUsername : undefined,
          basicPassword: authMode === "basic" ? basicPassword : undefined,
        },
        llm: {
          activeProviderId,
          activeModel,
          upsertProvider: {
            providerId: activeProviderId,
            label: providerLabel || undefined,
            baseUrl: providerBaseUrl || undefined,
            apiStyle: providerApiStyle,
            defaultModel: providerDefaultModel || undefined,
            apiKey: providerApiKey || undefined,
            apiKeyEnv: providerApiKeyEnv || undefined,
            request: providerRequestValidation.request,
          },
        },
        mesh: {
          enabled: meshEnabled,
          mode: meshMode,
          nodeId: meshNodeId || undefined,
          mdns: meshMdns,
          staticPeers: parseMultiline(meshStaticPeers),
          requireMtls: meshRequireMtls,
          tailnetEnabled: meshTailnetEnabled,
        },
        markComplete,
        completedBy: "mission-control",
      });

      setState(bootstrap.state);
      hydrateFromState(bootstrap.state);
      await reloadProviderCatalog();
      setApplyMessage(
        `Apply complete. Active provider: ${bootstrap.state.settings.llm.activeProviderId} · model: ${bootstrap.state.settings.llm.activeModel}.`,
      );
      if (bootstrap.state.completed) {
        onCompleted?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const completedChecklistItems = state?.checklist.filter((item) => item.status === "complete").length ?? 0;
  const totalChecklistItems = state?.checklist.length ?? 0;
  const daemonReady = daemonStatus?.running === true;
  const daemonControlSupported = daemonStatus?.controllable ?? false;

  if (loading) {
    return <p>Loading Launch Wizard...</p>;
  }

  return (
    <section className="workflow-page onboarding-wizard-page">
      <PageHeader
        eyebrow="Launch"
        title={pageCopy.onboarding.title}
        subtitle={pageCopy.onboarding.subtitle}
        hint="Use the wizard to land gateway access, provider setup, runtime defaults, mesh posture, and apply in one operator flow."
        density="compact"
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone={daemonReady ? "success" : "warning"}>
              Gateway {daemonReady ? "ready" : "needs attention"}
            </StatusChip>
            <StatusChip tone={state?.completed === true ? "success" : "muted"}>
              Checklist {completedChecklistItems}/{totalChecklistItems}
            </StatusChip>
            <StatusChip tone="muted">Step {step + 1}/5</StatusChip>
          </div>
        }
      />
      <PageGuideCard
        what={pageCopy.onboarding.guide?.what ?? ""}
        when={pageCopy.onboarding.guide?.when ?? ""}
        actions={pageCopy.onboarding.guide?.actions ?? []}
        terms={pageCopy.onboarding.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {applyMessage ? <p className="office-subtitle">{applyMessage}</p> : null}
      </div>

      <OnboardingWizardLayout
        leftRail={
          <div className="stack-md">
            <OnboardingStepNav
              step={step}
              applying={applying}
              steps={STEP_TITLES}
              onSelectStep={(nextStep) => setStep(nextStep as StepId)}
              onBack={() => setStep((current) => Math.max(0, current - 1) as StepId)}
              onNext={() => setStep((current) => Math.min(4, current + 1) as StepId)}
            />
            <OnboardingQuickstartProfilesPanel
              presets={QUICKSTART_PRESETS}
              onApplyQuickstartPreset={(presetId) =>
                applyQuickstartPreset(presetId as (typeof QUICKSTART_PRESETS)[number]["id"])
              }
            />
          </div>
        }
        main={
          <>
            {step === 0 ? (
        <article className="card">
          <h3>Step 1: Gateway Access</h3>
          <p className="office-subtitle">
            Choose how this GoatCitadel node should protect access. For a single local machine, <strong>none</strong> is
            the simplest starting point.
          </p>
          <div className="controls-row">
            <label htmlFor="wizard-auth-mode">
              Auth mode{" "}
              <HelpHint
                label="Auth mode help"
                text="Use none for trusted local-only testing. Use token or basic before exposing GoatCitadel on a non-loopback host."
              />
            </label>
            <select
              id="wizard-auth-mode"
              value={authMode}
              onChange={(event) => setAuthMode(event.target.value as "none" | "token" | "basic")}
            >
              <option value="none">none (local trusted)</option>
              <option value="token">token</option>
              <option value="basic">basic</option>
            </select>
          </div>
          <div className="controls-row">
            <label htmlFor="wizard-loopback">
              Allow loopback bypass{" "}
              <HelpHint
                label="Loopback bypass help"
                text="When enabled, localhost access can stay friction-free even if stronger auth is configured for remote access."
              />
            </label>
            <input
              id="wizard-loopback"
              type="checkbox"
              checked={allowLoopbackBypass}
              onChange={(event) => setAllowLoopbackBypass(event.target.checked)}
            />
          </div>
          {authMode === "token" ? (
            <>
              <div className="controls-row">
                <label htmlFor="wizard-token">Gateway token</label>
                <input
                  id="wizard-token"
                  type="password"
                  value={authToken}
                  onChange={(event) => setAuthToken(event.target.value)}
                />
                <button type="button" onClick={() => void handleResolveInstallToken()} disabled={installTokenBusy} className="gc-button">
                  {installTokenBusy ? "Resolving..." : "Generate install token"}
                </button>
              </div>
              {installTokenInfo ? (
                <div className="card">
                  <p>
                    <strong>Install token source:</strong> {installTokenInfo.source}
                  </p>
                  {installTokenInfo.token ? (
                    <p>
                      <code>{installTokenInfo.token}</code>
                    </p>
                  ) : null}
                  {installTokenInfo.warnings.length > 0 ? (
                    <ul className="compact-list">
                      {installTokenInfo.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {authMode === "basic" ? (
            <>
              <div className="controls-row">
                <label htmlFor="wizard-basic-username">Username</label>
                <input
                  id="wizard-basic-username"
                  value={basicUsername}
                  onChange={(event) => setBasicUsername(event.target.value)}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="wizard-basic-password">Password</label>
                <input
                  id="wizard-basic-password"
                  type="password"
                  value={basicPassword}
                  onChange={(event) => setBasicPassword(event.target.value)}
                />
              </div>
            </>
          ) : null}
        </article>
      ) : null}

            {step === 1 ? (
        <article className="card">
          <h3>Step 2: LLM Provider</h3>
          <p className="office-subtitle">
            Pick the company or endpoint GoatCitadel should use, then choose from a live-discovered model list when
            possible instead of guessing model names.
          </p>
          <div className="controls-row">
            <label htmlFor="wizard-provider-id">
              Provider{" "}
              <HelpHint
                label="Provider help"
                text="Provider is the endpoint family GoatCitadel will talk to, such as glm, moonshot, openai, or a local server like ollama."
              />
            </label>
            <SelectOrCustom
              id="wizard-provider-id"
              value={activeProviderId}
              onChange={(nextProviderId) => {
                setActiveProviderId(nextProviderId);
                applyProviderTemplate(nextProviderId);
              }}
              options={providerOptions}
              customPlaceholder="Custom provider id"
              customLabel="Custom provider"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="wizard-provider-label">
              Label{" "}
              <HelpHint
                label="Provider label help"
                text="Label is the display name shown in the UI. It is human-facing and can be friendlier than the provider ID."
              />
            </label>
            <SelectOrCustom
              id="wizard-provider-label"
              value={providerLabel}
              onChange={setProviderLabel}
              options={providerLabelOptions}
              customPlaceholder="Provider label"
              customLabel="Custom label"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="wizard-provider-url">
              Base URL{" "}
              <HelpHint
                label="Base URL help"
                text="Base URL is the API root GoatCitadel will call. For GLM the recommended base URL is https://api.z.ai/api/paas/v4."
              />
            </label>
            <SelectOrCustom
              id="wizard-provider-url"
              value={providerBaseUrl}
              onChange={setProviderBaseUrl}
              options={providerTemplates.map((template) => ({
                value: template.baseUrl,
                label: template.baseUrl,
              }))}
              customPlaceholder="https://host/v1"
              customLabel="Custom base URL"
            />
          </div>
          <p className="office-subtitle">Upstream API style: {providerApiStyle}</p>
          <div className="controls-row">
            <label htmlFor="wizard-model">
              Active model{" "}
              <HelpHint
                label="Active model help"
                text="This is the model GoatCitadel will use immediately after onboarding. The list is discovered live when the provider supports it."
              />
            </label>
            <SelectOrCustom
              id="wizard-model"
              value={activeModel}
              onChange={setActiveModel}
              options={modelOptions}
              customPlaceholder="Model id"
              customLabel="Custom model"
            />
          </div>
          {modelDiscoverySource ? (
            <p className="office-subtitle">
              Model discovery:{" "}
              {loadingModels
                ? "loading..."
                : modelDiscoverySource === "remote"
                  ? "live provider list"
                  : "fallback/default list"}
              {modelDiscoveryWarning ? ` · ${modelDiscoveryWarning}` : ""}
            </p>
          ) : null}
          <div className="controls-row">
            <label htmlFor="wizard-provider-default-model">
              Provider default model{" "}
              <HelpHint
                label="Provider default model help"
                text="Default model is the model GoatCitadel will prefer for this provider when a page or session has not pinned another one yet."
              />
            </label>
            <SelectOrCustom
              id="wizard-provider-default-model"
              value={providerDefaultModel}
              onChange={setProviderDefaultModel}
              options={modelOptions}
              customPlaceholder="Default model id"
              customLabel="Custom default model"
            />
          </div>
          <details className="advanced-panel">
            <summary>Advanced provider auth</summary>
            <p className="office-subtitle">
              Use secure-store or env-based auth when possible. If you enter an env var name, it should be the variable
              name itself, for example <code>GLM_API_KEY</code>.
            </p>
            <div className="controls-row">
              <label htmlFor="wizard-provider-api-key">API key (optional)</label>
              <input
                id="wizard-provider-api-key"
                type="password"
                value={providerApiKey}
                onChange={(event) => setProviderApiKey(event.target.value)}
              />
            </div>
            <div className="controls-row">
              <label htmlFor="wizard-provider-api-key-env">
                API key env var (optional){" "}
                <HelpHint
                  label="Provider env var help"
                  text="This is the environment variable name GoatCitadel should read at runtime, not the secret value itself."
                />
              </label>
              <input
                id="wizard-provider-api-key-env"
                value={providerApiKeyEnv}
                onChange={(event) => setProviderApiKeyEnv(event.target.value)}
              />
            </div>
            <LlmTransportFields
              idPrefix="wizard-provider-transport"
              draft={providerRequestDraft}
              onChange={setProviderRequestDraft}
              error={providerRequestValidation.error}
            />
          </details>
        </article>
      ) : null}

            {step === 2 ? (
        <article className="card">
          <h3>Step 3: Runtime Defaults</h3>
          <p className="office-subtitle">
            These defaults shape how aggressively GoatCitadel can act and which outbound hosts it may contact.
          </p>
          <div className="controls-row">
            <label htmlFor="wizard-tool-profile">Tool profile</label>
            <SelectOrCustom
              id="wizard-tool-profile"
              value={defaultToolProfile}
              onChange={setDefaultToolProfile}
              options={TOOL_PROFILE_OPTIONS}
              customPlaceholder="Custom profile"
              customLabel="Custom profile"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="wizard-budget">Budget mode</label>
            <select
              id="wizard-budget"
              value={budgetMode}
              onChange={(event) => setBudgetMode(event.target.value as RuntimeSettingsResponse["budgetMode"])}
            >
              {BUDGET_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
          <div className="controls-row">
            <label htmlFor="wizard-allowlist-preset">
              Network allowlist preset{" "}
              <HelpHint
                label="Network allowlist help"
                text="The network allowlist controls outbound hosts GoatCitadel may contact. It is not your desktop IP. Include localhost for local services and provider domains such as api.z.ai for cloud models."
              />
            </label>
            <select
              id="wizard-allowlist-preset"
              value={allowlistPreset}
              onChange={(event) => applyAllowlistPreset(event.target.value)}
            >
              {ALLOWLIST_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">custom</option>
            </select>
          </div>
          <label htmlFor="wizard-allowlist">Network allowlist (one host per line)</label>
          <textarea
            id="wizard-allowlist"
            rows={6}
            className="full-textarea"
            value={networkAllowlistText}
            onChange={(event) => {
              setAllowlistPreset("custom");
              setNetworkAllowlistText(event.target.value);
            }}
          />
        </article>
      ) : null}

            {step === 3 ? (
        <article className="card">
          <h3>Step 4: Mesh (Optional)</h3>
          <p className="office-subtitle">
            Mesh is only needed when you want multiple GoatCitadel nodes to cooperate. For a single-machine setup,
            leaving it off is correct.
          </p>
          <div className="controls-row">
            <label htmlFor="wizard-mesh-enabled">Enable mesh</label>
            <input
              id="wizard-mesh-enabled"
              type="checkbox"
              checked={meshEnabled}
              onChange={(event) => setMeshEnabled(event.target.checked)}
            />
          </div>
          {meshEnabled ? (
            <>
              <div className="controls-row">
                <label htmlFor="wizard-mesh-mode">
                  Mode{" "}
                  <HelpHint
                    label="Mesh mode help"
                    text="LAN is for local-network discovery, WAN is for explicitly reachable remote nodes, and tailnet is for Tailscale-style private networking."
                  />
                </label>
                <select
                  id="wizard-mesh-mode"
                  value={meshMode}
                  onChange={(event) => setMeshMode(event.target.value as "lan" | "wan" | "tailnet")}
                >
                  <option value="lan">LAN</option>
                  <option value="wan">WAN</option>
                  <option value="tailnet">Tailnet</option>
                </select>
              </div>
              <div className="controls-row">
                <label htmlFor="wizard-mesh-node-id">
                  Node ID{" "}
                  <HelpHint
                    label="Mesh node ID help"
                    text="Node ID is this GoatCitadel node's stable identity inside the mesh. It should be unique enough to distinguish this machine from other nodes."
                  />
                </label>
                <input
                  id="wizard-mesh-node-id"
                  value={meshNodeId}
                  onChange={(event) => setMeshNodeId(event.target.value)}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="wizard-mesh-mdns">
                  mDNS discovery{" "}
                  <HelpHint
                    label="mDNS discovery help"
                    text="mDNS lets local-network GoatCitadel nodes find each other automatically. Leave it on for simple LAN testing."
                  />
                </label>
                <input
                  id="wizard-mesh-mdns"
                  type="checkbox"
                  checked={meshMdns}
                  onChange={(event) => setMeshMdns(event.target.checked)}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="wizard-mesh-mtls">Require mTLS</label>
                <input
                  id="wizard-mesh-mtls"
                  type="checkbox"
                  checked={meshRequireMtls}
                  onChange={(event) => setMeshRequireMtls(event.target.checked)}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="wizard-mesh-tailnet">Tailnet mode enabled</label>
                <input
                  id="wizard-mesh-tailnet"
                  type="checkbox"
                  checked={meshTailnetEnabled}
                  onChange={(event) => setMeshTailnetEnabled(event.target.checked)}
                />
              </div>
              <label htmlFor="wizard-mesh-peers">
                Static peers (one per line){" "}
                <HelpHint
                  label="Static peers help"
                  text="Static peers are other GoatCitadel nodes you want to connect to directly. Leave this blank unless you are intentionally linking to another machine."
                />
              </label>
              <textarea
                id="wizard-mesh-peers"
                rows={4}
                className="full-textarea"
                value={meshStaticPeers}
                onChange={(event) => setMeshStaticPeers(event.target.value)}
              />
            </>
          ) : (
            <p className="office-subtitle">Mesh stays disabled for single-machine mode. You can enable it later.</p>
          )}
        </article>
      ) : null}

            {step === 4 ? (
              <OnboardingReviewApplyPanel
                changeReview={changeReview}
                criticalConfirmed={criticalConfirmed}
                setCriticalConfirmed={setCriticalConfirmed}
                markComplete={markComplete}
                setMarkComplete={setMarkComplete}
                summary={{
                  authMode,
                  activeProviderId,
                  activeModel,
                  defaultToolProfile,
                  budgetMode,
                  networkAllowlist: parseMultiline(networkAllowlistText),
                  mesh: {
                    enabled: meshEnabled,
                    mode: meshMode,
                    nodeId: meshNodeId,
                    mdns: meshMdns,
                    staticPeers: parseMultiline(meshStaticPeers),
                    requireMtls: meshRequireMtls,
                    tailnetEnabled: meshTailnetEnabled,
                  },
                }}
                applying={applying}
                onSubmit={submit}
              />
            ) : null}
          </>
        }
        rightRail={
          <div className="stack-md">
            <OnboardingReadinessPanel
              daemonReady={daemonReady}
              completedChecklistItems={completedChecklistItems}
              totalChecklistItems={totalChecklistItems}
              wizardCompleted={state?.completed === true}
              daemonStatus={daemonStatus}
              daemonBusy={daemonBusy}
              daemonControlSupported={daemonControlSupported}
              onDaemonAction={handleDaemonAction}
              onRefresh={async () => {
                await load();
              }}
            />
            <OnboardingProgressPanel
              stepTitle={STEP_TITLES[step]}
              checklist={state?.checklist ?? []}
              onRefresh={async () => {
                await load();
              }}
            />
          </div>
        }
      />
    </section>
  );
}

function parseMultiline(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
