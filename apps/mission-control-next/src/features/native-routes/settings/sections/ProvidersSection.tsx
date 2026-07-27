/* eslint-disable max-lines -- ProvidersSection is a single large editor component moved verbatim from SettingsNativePage.tsx; splitting its internals is deferred until the provider editor surface settles. */
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition. Shared helpers stay in SettingsShared;
// exported provider helpers remain in SettingsNativePage (tests import them).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  Gauge,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { LlmProviderAdviceResponse } from "@goatcitadel/contracts";
import {
  deleteOpenAICodexOAuthCredential,
  deleteProviderSecret,
  fetchLlmProviderAdvice,
  fetchOpenAICodexOAuthStatus,
  fetchProviderSecretStatus,
  isApiRequestError,
  type OpenAICodexDevicePollResponse,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexOAuthStatus,
  patchSettings,
  pollOpenAICodexOAuthDeviceFlow,
  saveProviderSecret,
  startOpenAICodexOAuthDeviceFlow,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  LlmTransportFields,
  requestConfigFromDraft,
  type LlmTransportDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  buildUniversalModelPickerOptions,
  type ProviderModelCatalogOption,
  useProviderModelCatalog,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import {
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  type LoadState,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  SettingsWizardSteps,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { useDraftTransitionGuard, useFormDirty } from "../../library/use-form-dirty";
import {
  buildChatGptOAuthProviderDraft,
  buildProviderEditorDraft,
  clearStoredOpenAICodexOAuthFlow,
  createEmptyProviderEditorDraft,
  deriveProviderSmokeEvidenceItems,
  formatCapabilities,
  formatOpenAICodexOAuthExpiry,
  formatProviderCredentialLabel,
  formatProviderModelsMeta,
  formatProviderProbeSourceMeta,
  formatProviderProbeStateLabel,
  getProviderApiStyleWarning,
  isLikelyLocalProviderBaseUrl,
  isStoredOpenAICodexOAuthFlow,
  isTrustedOpenAICodexVerificationUrl,
  normalizeOpenAICodexPollDelayMs,
  OPENAI_CODEX_MIN_POLL_MS,
  type ProviderEditorDraft,
  readStoredOpenAICodexOAuthFlow,
  resolveProviderCredentialReady,
  writeStoredOpenAICodexOAuthFlow,
} from "../../SettingsNativePage";

const PROVIDER_API_STYLE_OPTIONS: ProviderEditorDraft["apiStyle"][] = [
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "openai-chat-completions",
  "bedrock-messages",
];

type ProviderEditorTransition =
  | { kind: "select"; providerId: string }
  | { kind: "new" }
  | { kind: "routing"; providerId: string; model?: string };

function areProviderEditorDraftsEqual(a: ProviderEditorDraft, b: ProviderEditorDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function areProviderTransportDraftsEqual(a: LlmTransportDraft, b: LlmTransportDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ProvidersSection({ activeWorkspaceId }: SettingsSectionProps) {
  const { config, providers, loading, error, reload, loadModelsForProvider, getCachedModelProbe } =
    useProviderModelCatalog("system");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [routingProviderId, setRoutingProviderId] = useState("");
  const [routingModel, setRoutingModel] = useState("");
  const [routingBaseline, setRoutingBaseline] = useState({ providerId: "", model: "" });
  const [secretValue, setSecretValue] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [providerDraft, setProviderDraft] = useState<ProviderEditorDraft>(createEmptyProviderEditorDraft);
  const [providerTransportDraft, setProviderTransportDraft] = useState(createEmptyLlmTransportDraft);
  const [providerBaselineDraft, setProviderBaselineDraft] =
    useState<ProviderEditorDraft>(createEmptyProviderEditorDraft);
  const [providerTransportBaselineDraft, setProviderTransportBaselineDraft] = useState(createEmptyLlmTransportDraft);
  const [providerSaveBusy, setProviderSaveBusy] = useState(false);
  const [pendingDeleteSecret, setPendingDeleteSecret] = useState<{ providerId: string; label: string } | null>(null);
  const [deleteSecretBusy, setDeleteSecretBusy] = useState(false);
  const [providerProbeBusyId, setProviderProbeBusyId] = useState<string | null>(null);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [codexOAuthStatus, setCodexOAuthStatus] = useState<OpenAICodexOAuthStatus | null>(null);
  const [codexOAuthFlow, setCodexOAuthFlow] = useState<OpenAICodexDeviceStartResponse | null>(
    readStoredOpenAICodexOAuthFlow,
  );
  const [codexOAuthBusy, setCodexOAuthBusy] = useState(false);
  const [providerAdvice, setProviderAdvice] = useState<LoadState<LlmProviderAdviceResponse>>({
    loading: false,
    error: null,
    data: null,
  });
  const codexOAuthPollInFlightRef = useRef<string | null>(null);
  const codexOAuthStatusRequestIdRef = useRef(0);
  const [secretState, setSecretState] = useState<LoadState<Awaited<ReturnType<typeof fetchProviderSecretStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const providerConfigMap = useMemo(
    () => new Map((config?.providerConfigs ?? []).map((provider) => [provider.providerId, provider] as const)),
    [config?.providerConfigs],
  );
  const codexOAuthProvider = providers.find((item) => item.providerId === "openai-codex") ?? null;
  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? providers[0] ?? null;
  const selectedProviderConfig = selectedProvider ? providerConfigMap.get(selectedProvider.providerId) : undefined;
  const providerEditorDirty =
    !areProviderEditorDraftsEqual(providerDraft, providerBaselineDraft) ||
    !areProviderTransportDraftsEqual(providerTransportDraft, providerTransportBaselineDraft);
  const routingDirty = routingProviderId !== routingBaseline.providerId || routingModel !== routingBaseline.model;
  const secretDraftDirty = secretValue.length > 0;
  const editorSelectionDirty = providerEditorDirty || secretDraftDirty;
  useFormDirty("settings:providers", editorSelectionDirty || routingDirty, { label: "Providers & Models" });
  const availableModels = selectedProvider?.models ?? [];
  const routingProvider = providers.find((item) => item.providerId === routingProviderId) ?? null;
  const routingUsesFallbackModels = routingProvider?.modelProbeState === "fallback";
  const providerRequestValidation = useMemo(() => {
    try {
      return {
        request: requestConfigFromDraft(providerTransportDraft),
        error: null,
      };
    } catch (draftError) {
      return {
        request: undefined,
        error: getErrorMessage(draftError),
      };
    }
  }, [providerTransportDraft]);
  const selectedProviderIsLocal = isLikelyLocalProviderBaseUrl(selectedProvider?.baseUrl);
  const selectedProviderIsCodexOAuth = selectedProvider?.providerId === "openai-codex";
  const selectedProviderIsClaudeCodeOAuth = selectedProvider?.providerId === "claude-code";
  const selectedProviderIsGoogleAdc = selectedProvider?.authMode === "google-adc";
  const selectedProviderIsGoogleServiceAccount = selectedProvider?.authMode === "google-service-account";
  const draftIsCodexOAuth =
    providerDraft.providerId.trim().toLowerCase() === "openai-codex" || providerDraft.authMode === "codex-oauth";
  const draftUsesGoogleAuth =
    providerDraft.authMode === "google-adc" || providerDraft.authMode === "google-service-account";
  const hasCodexOAuthProvider = Boolean(codexOAuthProvider);
  const codexOAuthConnected = Boolean(codexOAuthStatus?.connected);
  const hasCodexOAuthCredential = Boolean(codexOAuthStatus?.connected || codexOAuthStatus?.requiresReauth);
  const hasOrphanCodexOAuthCredential = !hasCodexOAuthProvider && hasCodexOAuthCredential;
  const codexOAuthFlowUserCode = codexOAuthFlow?.userCode?.trim() ?? "";
  const codexOAuthExpiryLabel = useMemo(() => formatOpenAICodexOAuthExpiry(codexOAuthFlow), [codexOAuthFlow]);
  const refreshCodexOAuthStatus = useCallback(async () => {
    const requestId = codexOAuthStatusRequestIdRef.current + 1;
    codexOAuthStatusRequestIdRef.current = requestId;
    const data = await fetchOpenAICodexOAuthStatus();
    if (codexOAuthStatusRequestIdRef.current === requestId) {
      setCodexOAuthStatus(data);
    }
    return data;
  }, []);
  const setAuthoritativeCodexOAuthStatus = useCallback((status: OpenAICodexOAuthStatus) => {
    codexOAuthStatusRequestIdRef.current += 1;
    setCodexOAuthStatus(status);
  }, []);
  const codexOAuthWizardSteps = useMemo(
    () => [
      {
        label: "Provider",
        description: hasCodexOAuthProvider
          ? "GoatCitadel has the OpenAI Codex provider template ready."
          : "Add the built-in OpenAI Codex provider template.",
        state: hasCodexOAuthProvider ? ("complete" as const) : ("active" as const),
      },
      {
        label: "ChatGPT login",
        description: codexOAuthConnected
          ? "A ChatGPT OAuth credential is stored securely in the OS keychain."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? "Use the active device code below."
              : "Finish the OpenAI browser approval window."
            : "Start browser login and sign in with OpenAI.",
        state: codexOAuthConnected || codexOAuthFlow ? ("complete" as const) : ("active" as const),
      },
      {
        label: "OpenAI approval",
        description: codexOAuthConnected
          ? "OpenAI approved the login."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? `Enter exactly ${codexOAuthFlowUserCode} on the OpenAI page.`
              : "Complete the OpenAI approval tab."
            : "The OpenAI page opens after login starts.",
        state: codexOAuthConnected
          ? ("complete" as const)
          : codexOAuthFlow
            ? ("active" as const)
            : ("pending" as const),
      },
      {
        label: "Done",
        description: codexOAuthConnected
          ? "GoatCitadel can use the connected ChatGPT/Codex plan."
          : codexOAuthFlow
            ? "GoatCitadel is checking automatically; this tab can stay open."
            : "After approval, GoatCitadel confirms the connection here.",
        state: codexOAuthConnected
          ? ("complete" as const)
          : codexOAuthFlow
            ? ("active" as const)
            : ("pending" as const),
      },
    ],
    [codexOAuthConnected, codexOAuthFlow, codexOAuthFlowUserCode, hasCodexOAuthProvider],
  );
  const selectedProviderRuntimePosture = selectedProvider
    ? selectedProviderIsLocal
      ? "Local runtime"
      : "Remote provider"
    : "Provider pending";
  const selectedProviderExecutionApiStyle = selectedProvider?.resolvedApiStyle ?? selectedProvider?.apiStyle;
  const selectedProviderApiMeta =
    selectedProvider &&
    selectedProviderExecutionApiStyle &&
    selectedProviderExecutionApiStyle !== selectedProvider.apiStyle
      ? `Gateway executes ${selectedProviderExecutionApiStyle}`
      : "Matches configured API";
  const providerApiStyleWarning = getProviderApiStyleWarning(providerDraft);
  const editorHint =
    editorMode === "new"
      ? "Create a new provider definition without expanding the gateway."
      : "Edit the selected provider through runtime settings. Secrets stay on the secure secret endpoints.";
  const selectedProviderCredentialReady = selectedProvider
    ? resolveProviderCredentialReady({
        providerId: selectedProvider.providerId,
        authMode: selectedProvider.authMode,
        hasApiKey: selectedProvider.hasApiKey,
        hasSecret: secretState.data?.hasSecret,
        oauthConnected: codexOAuthConnected,
        localEndpoint: selectedProviderIsLocal,
      })
    : false;
  const selectedProviderCredentialMeta = selectedProvider
    ? selectedProviderIsCodexOAuth
      ? codexOAuthConnected
        ? (codexOAuthStatus?.accountLabel ?? "OAuth connected")
        : codexOAuthStatus?.requiresReauth
          ? "OAuth requires reauth"
          : "OAuth not connected"
      : selectedProviderIsLocal && !(secretState.data?.hasSecret || selectedProvider.hasApiKey)
        ? "Local endpoint, no key required"
        : selectedProviderIsGoogleAdc
          ? formatGoogleAdcReadinessMeta(selectedProvider.authReadiness)
          : formatSecretStatusMeta(
              secretState.data?.source ?? selectedProvider.apiKeySource,
              secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
            )
    : "No provider selected";
  const selectedProviderSmokeEvidenceItems = selectedProvider
    ? deriveProviderSmokeEvidenceItems({
        providerId: selectedProvider.providerId,
        providerLabel: selectedProvider.label,
        credentialReady: selectedProviderCredentialReady,
        credentialMeta: selectedProviderCredentialMeta,
        localEndpoint: selectedProviderIsLocal,
        modelCount: availableModels.length,
        modelProbeState: selectedProvider.modelProbeState,
        modelProbeSource: selectedProvider.modelProbeSource,
        modelProbeCheckedAt: selectedProvider.modelProbeCheckedAt,
        modelProbeWarning: selectedProvider.modelProbeWarning,
        request: selectedProviderConfig?.request,
      })
    : [];
  const universalModelOptions = useMemo(
    () =>
      buildUniversalModelPickerOptions({
        providers,
        query: modelPickerQuery,
        activeProviderId: config?.activeProviderId,
        activeModel: config?.activeModel,
      }),
    [config?.activeModel, config?.activeProviderId, modelPickerQuery, providers],
  );

  const resetCurrentProviderDraft = useCallback(() => {
    setProviderDraft(providerBaselineDraft);
    setProviderTransportDraft(providerTransportBaselineDraft);
    setSecretValue("");
  }, [providerBaselineDraft, providerTransportBaselineDraft]);

  const applyProviderTransition = useCallback(
    (transition: ProviderEditorTransition) => {
      if (transition.kind === "new") {
        const emptyProviderDraft = createEmptyProviderEditorDraft();
        const emptyTransportDraft = createEmptyLlmTransportDraft();
        setEditorMode("new");
        setProviderDraft(emptyProviderDraft);
        setProviderBaselineDraft(emptyProviderDraft);
        setProviderTransportDraft(emptyTransportDraft);
        setProviderTransportBaselineDraft(emptyTransportDraft);
        setSecretValue("");
        setNotice({
          tone: "info",
          message: "Started a new provider draft. Save it through Settings when the fields are ready.",
        });
        return;
      }
      const nextProvider = providers.find((item) => item.providerId === transition.providerId);
      if (transition.kind === "routing") {
        setRoutingProviderId(transition.providerId);
        setRoutingModel(transition.model ?? nextProvider?.defaultModel ?? nextProvider?.models?.[0] ?? "");
      }
      setEditorMode("selected");
      setSelectedProviderId(transition.providerId);
      setSecretValue("");
    },
    [providers],
  );

  const providerTransitionGuard = useDraftTransitionGuard(
    editorSelectionDirty,
    applyProviderTransition,
    resetCurrentProviderDraft,
  );

  useEffect(() => {
    if (!providers.length) {
      setSelectedProviderId("");
      return;
    }
    setSelectedProviderId((current) => current || config?.activeProviderId || providers[0]?.providerId || "");
  }, [config?.activeProviderId, providers]);

  useEffect(() => {
    if (!config || routingDirty) {
      return;
    }
    setRoutingProviderId(config.activeProviderId);
    setRoutingModel(config.activeModel);
    setRoutingBaseline({ providerId: config.activeProviderId, model: config.activeModel });
    // Reconcile only when the server snapshot changes. A local baseline update
    // after save must not immediately snap the controlled fields back to the
    // previous config object while reload is still in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    if (!selectedProviderId) {
      setSecretState({ loading: false, error: null, data: null });
      return;
    }
    if (selectedProviderId === "openai-codex") {
      setSecretState({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setSecretState({ loading: true, error: null, data: null });
    void fetchProviderSecretStatus(selectedProviderId)
      .then((data) => {
        if (!cancelled) {
          setSecretState({ loading: false, error: null, data });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setSecretState({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProviderId]);

  useEffect(() => {
    if (!hasCodexOAuthProvider) {
      setCodexOAuthFlow(null);
    }
    let cancelled = false;
    const requestId = codexOAuthStatusRequestIdRef.current + 1;
    codexOAuthStatusRequestIdRef.current = requestId;
    void fetchOpenAICodexOAuthStatus()
      .then((data) => {
        if (!cancelled && codexOAuthStatusRequestIdRef.current === requestId) {
          setCodexOAuthStatus(data);
        }
      })
      .catch(() => {
        if (!cancelled && codexOAuthStatusRequestIdRef.current === requestId) {
          setCodexOAuthStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasCodexOAuthProvider]);

  useEffect(() => {
    if (selectedProviderId) {
      void loadModelsForProvider(selectedProviderId);
    }
  }, [loadModelsForProvider, selectedProviderId]);

  useEffect(() => {
    if (!selectedProvider) {
      if (editorMode !== "new") {
        const emptyProviderDraft = createEmptyProviderEditorDraft();
        const emptyTransportDraft = createEmptyLlmTransportDraft();
        setProviderDraft(emptyProviderDraft);
        setProviderBaselineDraft(emptyProviderDraft);
        setProviderTransportDraft(emptyTransportDraft);
        setProviderTransportBaselineDraft(emptyTransportDraft);
      }
      return;
    }
    if (editorMode === "new") {
      return;
    }
    if (providerEditorDirty) {
      return;
    }
    const nextProviderDraft = buildProviderEditorDraft(selectedProviderConfig ?? selectedProvider);
    const nextTransportDraft = draftFromRequestConfig(selectedProviderConfig?.request);
    setProviderDraft(nextProviderDraft);
    setProviderBaselineDraft(nextProviderDraft);
    setProviderTransportDraft(nextTransportDraft);
    setProviderTransportBaselineDraft(nextTransportDraft);
  }, [editorMode, providerEditorDirty, selectedProvider, selectedProviderConfig]);

  const handleSaveRouting = async () => {
    if (!routingProviderId.trim() || !routingModel.trim()) {
      setNotice({ tone: "warning", message: "Choose both a provider and a model before saving routing." });
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving routing." });
      return;
    }
    try {
      await patchSettings({
        expectedRevision: config.revision,
        llm: {
          activeProviderId: routingProviderId,
          activeModel: routingModel,
        },
      });
      setNotice({
        tone: routingUsesFallbackModels ? "warning" : "success",
        message: routingUsesFallbackModels
          ? "Provider routing updated with a suggested model that has not been account-verified."
          : "Provider routing updated.",
      });
      setRoutingBaseline({ providerId: routingProviderId, model: routingModel });
      await reload();
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Provider settings changed elsewhere. Your routing draft is preserved; review the current settings, then save again to retry.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleLoadProviderAdvice = async () => {
    setProviderAdvice({ loading: true, error: null, data: null });
    try {
      const advice = await fetchLlmProviderAdvice({
        preference: "runtime_fit",
        taskHint: "general GoatCitadel chat, code, and orchestration routing",
        maxCandidates: 5,
      });
      setProviderAdvice({ loading: false, error: null, data: advice });
    } catch (adviceError) {
      setProviderAdvice({ loading: false, error: getErrorMessage(adviceError), data: null });
    }
  };

  const handleSaveSecret = async () => {
    if (!selectedProviderId.trim() || !secretValue.trim()) {
      setNotice({ tone: "warning", message: "Enter a provider secret before saving." });
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving a secret." });
      return;
    }
    try {
      const next = await saveProviderSecret(selectedProviderId, secretValue.trim(), config.revision);
      setSecretState({ loading: false, error: null, data: next });
      setSecretValue("");
      setNotice({
        tone: "success",
        message: `Provider secret saved. ${formatSecretStorageNotice(next.source, next.hasSecret)}`,
      });
      await reload();
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message: "Provider settings changed elsewhere. Your secret was not changed; review and save again.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleDeleteSecret = async () => {
    if (!pendingDeleteSecret) {
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before removing a secret." });
      return;
    }
    setDeleteSecretBusy(true);
    try {
      const next = await deleteProviderSecret(pendingDeleteSecret.providerId, config.revision);
      setSecretState({ loading: false, error: null, data: next });
      setNotice({
        tone: "success",
        message: `Provider secret removed. ${formatSecretStorageNotice(next.source, next.hasSecret)}`,
      });
      setPendingDeleteSecret(null);
      await reload();
    } catch (deleteError) {
      if (isApiRequestError(deleteError) && deleteError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message: "Provider settings changed elsewhere. No secret was removed; review and try again.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
    } finally {
      setDeleteSecretBusy(false);
    }
  };

  const handleCodexOAuthPollResult = useCallback(
    async (result: OpenAICodexDevicePollResponse, options: { showPendingNotice?: boolean } = {}) => {
      if (result.status === "connected") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        const nextStatus = await refreshCodexOAuthStatus();
        await reload();
        if (nextStatus.connected) {
          setNotice({ tone: "success", message: "OpenAI Codex OAuth connected." });
        } else {
          setNotice({
            tone: "warning",
            message:
              "OpenAI approved the login, but GoatCitadel could not confirm a saved ChatGPT OAuth credential. Start ChatGPT login again.",
          });
        }
        return false;
      }
      if (result.status === "expired") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        setNotice({ tone: "warning", message: "OpenAI Codex OAuth login expired. Start ChatGPT login again." });
        return false;
      }
      if (result.status === "failed") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        setNotice({ tone: "error", message: result.error ?? "OpenAI Codex OAuth pairing failed." });
        return false;
      }
      if (options.showPendingNotice) {
        setNotice({ tone: "info", message: "Still waiting for OpenAI approval for this login." });
      }
      return true;
    },
    [refreshCodexOAuthStatus, reload],
  );

  const openCodexOAuthVerificationUrl = useCallback((verificationUrl: string) => {
    if (!isTrustedOpenAICodexVerificationUrl(verificationUrl)) {
      setNotice({ tone: "error", message: "OpenAI verification URL was not trusted. Start a new ChatGPT login." });
      return;
    }
    globalThis.open?.(verificationUrl, "_blank", "noopener,noreferrer");
  }, []);

  const handleStartCodexOAuth = async (openVerificationPage = false) => {
    setCodexOAuthBusy(true);
    try {
      const flow = await startOpenAICodexOAuthDeviceFlow();
      if (!isStoredOpenAICodexOAuthFlow(flow)) {
        throw new Error("OpenAI Codex OAuth start returned an invalid login flow.");
      }
      setCodexOAuthFlow(flow);
      writeStoredOpenAICodexOAuthFlow(flow);
      if (openVerificationPage) {
        openCodexOAuthVerificationUrl(flow.verificationUrl);
      }
      setNotice({
        tone: "success",
        message: openVerificationPage
          ? "ChatGPT login started. If the OpenAI page did not open, use the Open OpenAI page button."
          : flow.userCode
            ? "ChatGPT login started. Use the code shown below on the OpenAI page."
            : "ChatGPT login started. Complete the OpenAI browser approval.",
      });
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      setCodexOAuthBusy(false);
    }
  };

  const handleRestartCodexOAuth = async () => {
    setCodexOAuthFlow(null);
    clearStoredOpenAICodexOAuthFlow();
    await handleStartCodexOAuth(true);
  };

  const handlePollCodexOAuth = async () => {
    if (!codexOAuthFlow) {
      setNotice({ tone: "warning", message: "Start ChatGPT login first." });
      return;
    }
    if (codexOAuthPollInFlightRef.current === codexOAuthFlow.flowId) {
      setNotice({ tone: "info", message: "GoatCitadel is already checking this OpenAI login." });
      return;
    }
    setCodexOAuthBusy(true);
    codexOAuthPollInFlightRef.current = codexOAuthFlow.flowId;
    try {
      const result = await pollOpenAICodexOAuthDeviceFlow(codexOAuthFlow.flowId);
      await handleCodexOAuthPollResult(result, { showPendingNotice: true });
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      codexOAuthPollInFlightRef.current = null;
      setCodexOAuthBusy(false);
    }
  };

  const handleDisconnectCodexOAuth = async () => {
    setCodexOAuthBusy(true);
    try {
      setAuthoritativeCodexOAuthStatus(await deleteOpenAICodexOAuthCredential());
      setCodexOAuthFlow(null);
      clearStoredOpenAICodexOAuthFlow();
      setNotice({ tone: "success", message: "OpenAI Codex OAuth disconnected." });
      await reload();
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      setCodexOAuthBusy(false);
    }
  };

  useEffect(() => {
    if (!codexOAuthFlow) {
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const flowId = codexOAuthFlow.flowId;
    const scheduleNextPoll = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timeoutId = globalThis.setTimeout(
        pollCurrentFlow,
        Math.max(normalizeOpenAICodexPollDelayMs(delayMs), OPENAI_CODEX_MIN_POLL_MS),
      );
    };
    const pollCurrentFlow = () => {
      if (codexOAuthPollInFlightRef.current === flowId) {
        scheduleNextPoll(codexOAuthFlow.pollAfterMs);
        return;
      }
      codexOAuthPollInFlightRef.current = flowId;
      setCodexOAuthBusy(true);
      void pollOpenAICodexOAuthDeviceFlow(flowId)
        .then(async (result) => {
          if (cancelled) {
            return;
          }
          const shouldContinue = await handleCodexOAuthPollResult(result);
          if (shouldContinue) {
            scheduleNextPoll(result.retryAfterMs ?? codexOAuthFlow.pollAfterMs);
          }
        })
        .catch((pollError) => {
          if (!cancelled) {
            setNotice({ tone: "error", message: getErrorMessage(pollError) });
          }
        })
        .finally(() => {
          // Release busy whenever THIS poll settles or is abandoned — not only when !cancelled.
          // If the effect was cancelled mid-flight, cleanup() already nulled the in-flight ref,
          // so gate on (ref === flowId) || (ref === null); both mean no live poll owns busy.
          // Do NOT release when the ref points at a DIFFERENT flowId: a newer flow now owns it.
          if (codexOAuthPollInFlightRef.current === flowId) {
            codexOAuthPollInFlightRef.current = null;
            setCodexOAuthBusy(false);
          } else if (codexOAuthPollInFlightRef.current === null) {
            setCodexOAuthBusy(false);
          }
        });
    };
    pollCurrentFlow();
    return () => {
      cancelled = true;
      if (timeoutId) {
        globalThis.clearTimeout(timeoutId);
      }
      if (codexOAuthPollInFlightRef.current === flowId) {
        codexOAuthPollInFlightRef.current = null;
      }
    };
  }, [codexOAuthFlow, handleCodexOAuthPollResult]);

  const handleAddChatGptOAuthProvider = async () => {
    if (hasCodexOAuthProvider) {
      setEditorMode("selected");
      setSelectedProviderId("openai-codex");
      setNotice({ tone: "info", message: "OpenAI Codex is already configured. Connect ChatGPT OAuth below." });
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before adding a provider." });
      return;
    }
    const draft = buildChatGptOAuthProviderDraft();
    setProviderSaveBusy(true);
    try {
      await patchSettings({
        expectedRevision: config.revision,
        llm: {
          upsertProvider: {
            providerId: draft.providerId,
            label: draft.label,
            baseUrl: draft.baseUrl,
            apiStyle: draft.apiStyle,
            authMode: "codex-oauth",
            defaultModel: draft.defaultModel,
          },
        },
      });
      await reload();
      setEditorMode("selected");
      setProviderDraft(draft);
      setProviderBaselineDraft(draft);
      const emptyTransportDraft = createEmptyLlmTransportDraft();
      setProviderTransportDraft(emptyTransportDraft);
      setProviderTransportBaselineDraft(emptyTransportDraft);
      setSelectedProviderId(draft.providerId);
      setNotice({ tone: "success", message: "ChatGPT provider added. Start ChatGPT login below." });
      void loadModelsForProvider(draft.providerId, { force: true });
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message: "Provider settings changed elsewhere. Review the current settings, then add ChatGPT setup again.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      setProviderSaveBusy(false);
    }
  };

  const handleSaveProvider = async () => {
    if (!providerDraft.providerId.trim() || !providerDraft.baseUrl.trim()) {
      setNotice({ tone: "warning", message: "Provide both a provider id and base URL before saving." });
      return;
    }
    if (!config) {
      setNotice({ tone: "warning", message: "Reload provider settings before saving this provider." });
      return;
    }
    if (providerRequestValidation.error) {
      setNotice({ tone: "error", message: providerRequestValidation.error });
      return;
    }
    setProviderSaveBusy(true);
    try {
      await patchSettings({
        expectedRevision: config.revision,
        llm: {
          upsertProvider: {
            providerId: providerDraft.providerId.trim(),
            label: providerDraft.label.trim() || undefined,
            baseUrl: providerDraft.baseUrl.trim(),
            apiStyle: providerDraft.apiStyle,
            authMode: draftIsCodexOAuth ? "codex-oauth" : providerDraft.authMode || undefined,
            defaultModel: providerDraft.defaultModel.trim() || undefined,
            apiKeyEnv:
              draftIsCodexOAuth || providerDraft.authMode === "google-adc"
                ? undefined
                : providerDraft.apiKeyEnv.trim() || undefined,
            googleCloud: draftUsesGoogleAuth
              ? {
                  projectId: providerDraft.googleProjectId.trim() || undefined,
                  projectIdEnv: providerDraft.googleProjectIdEnv.trim() || undefined,
                  location: providerDraft.googleLocation.trim() || undefined,
                  locationEnv: providerDraft.googleLocationEnv.trim() || undefined,
                  endpointId: providerDraft.googleEndpointId.trim() || undefined,
                }
              : undefined,
            request: providerRequestValidation.request,
          },
        },
      });
      setProviderBaselineDraft(providerDraft);
      setProviderTransportBaselineDraft(providerTransportDraft);
      await reload();
      setEditorMode("selected");
      setSelectedProviderId(providerDraft.providerId.trim());
      setNotice({ tone: "success", message: `Saved provider ${providerDraft.providerId.trim()}.` });
      void loadModelsForProvider(providerDraft.providerId.trim(), { force: true });
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Provider settings changed elsewhere. Your provider draft is preserved; review the current settings, then save again to retry.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      setProviderSaveBusy(false);
    }
  };

  const handleStartNewProviderDraft = () => {
    if (editorMode === "new") {
      return;
    }
    providerTransitionGuard.requestTransition({ kind: "new" });
  };

  const handleOpenCodexOAuthVerification = () => {
    if (!codexOAuthFlow?.verificationUrl) {
      return;
    }
    openCodexOAuthVerificationUrl(codexOAuthFlow.verificationUrl);
  };

  const handleShowCodexOAuthProviderDetail = () => {
    setEditorMode("selected");
    setSelectedProviderId("openai-codex");
  };

  const handleRefreshModels = async (providerId: string) => {
    const normalized = providerId.trim();
    if (!normalized) {
      setNotice({ tone: "warning", message: "Choose or save a provider before probing models." });
      return;
    }
    setProviderProbeBusyId(normalized);
    try {
      const items = await loadModelsForProvider(normalized, { force: true });
      const probe = getCachedModelProbe(normalized);
      const fallbackOnly = probe?.state === "fallback";
      const failedFallback = probe?.source === "error_fallback";
      const failedProbe = probe?.state === "error";
      setNotice({
        tone: items.length > 0 && !fallbackOnly && !failedProbe ? "success" : "warning",
        message: failedProbe
          ? `Model discovery failed for ${normalized}${probe?.warning ? `: ${probe.warning}` : "."}`
          : fallbackOnly
            ? failedFallback
              ? `Loaded ${items.length} fallback models for ${normalized}; live discovery failed${probe?.warning ? `: ${probe.warning}` : "."}`
              : `Loaded ${items.length} suggested models for ${normalized}; this catalog was not verified against your account.`
            : items.length > 0
              ? `Refreshed ${items.length} models for ${normalized}.`
              : `Probe completed for ${normalized}, but no models were returned.`,
      });
      await reload();
    } catch (probeError) {
      setNotice({ tone: "error", message: getErrorMessage(probeError) });
    } finally {
      setProviderProbeBusyId(null);
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid variant="detail-wide" className="mc-next-provider-master-detail">
        <NativeCard
          density="compact"
          className="mc-next-settings-panel mc-next-provider-directory"
          title="Providers & Models"
          subtitle="Available providers, probe posture, and current catalog coverage."
          scrollBody
          bodyMaxHeight="min(62vh, 36rem)"
          stats={[
            { label: "Configured", value: String(providers.length) },
            { label: "Active workspace", value: activeWorkspaceId },
          ]}
        >
          <SettingsButtonRow>
            <NativeButton
              variant="default"
              onClick={() => void handleAddChatGptOAuthProvider()}
              disabled={providerSaveBusy}
            >
              <KeyRound size={16} />
              {hasCodexOAuthProvider ? "ChatGPT setup" : "Add ChatGPT setup"}
            </NativeButton>
            <NativeButton variant="secondary" onClick={handleStartNewProviderDraft}>
              <Plus size={16} />
              New provider draft
            </NativeButton>
          </SettingsButtonRow>
          <NativeSelectableList
            items={providers.map((item) => ({
              id: item.providerId,
              title: item.label,
              meta: item.providerId,
              body: [
                `${item.models.length} models`,
                formatProviderCredentialLabel(item.providerId, item.hasApiKey, codexOAuthStatus),
                formatProviderProbeStateLabel(item.modelProbeState),
              ].join(" · "),
            }))}
            selectedId={selectedProviderId}
            onSelect={(providerId) => {
              if (editorMode === "selected" && providerId === selectedProviderId) {
                return;
              }
              providerTransitionGuard.requestTransition({ kind: "select", providerId });
            }}
            emptyLabel="No providers returned from runtime settings."
            maxHeight="min(44vh, 25rem)"
          />
        </NativeCard>
        <SettingsStack className="mc-next-provider-detail-stack">
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-routing-card"
            title="Active routing"
            subtitle="Change the provider/model pair Mission Control uses by default."
          >
            <SettingsFieldGrid>
              <SettingsField label="Provider">
                <select
                  className="mc-next-settings-input"
                  value={routingProviderId}
                  onChange={(event) => {
                    const nextProviderId = event.target.value;
                    if (nextProviderId === routingProviderId) {
                      return;
                    }
                    providerTransitionGuard.requestTransition({ kind: "routing", providerId: nextProviderId });
                  }}
                >
                  {providers.map((item) => (
                    <option key={item.providerId} value={item.providerId}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField label="Model">
                <select
                  className="mc-next-settings-input"
                  value={routingModel}
                  onChange={(event) => setRoutingModel(event.target.value)}
                >
                  {(providers.find((item) => item.providerId === routingProviderId)?.models ?? []).map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {modelId}
                    </option>
                  ))}
                </select>
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsConfigSourceLegend />
            {routingUsesFallbackModels ? (
              <SettingsNotice
                notice={{
                  tone: "warning",
                  message:
                    "These models are suggested from GoatCitadel's provider template, not verified from your account catalog yet.",
                }}
              />
            ) : null}
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void handleSaveRouting()}>
                <Save size={16} />
                Save routing
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-model-picker-card"
            title="Universal model picker"
            subtitle="Search configured provider catalogs with runtime fallback and availability evidence."
            scrollBody
            bodyMaxHeight="min(58vh, 34rem)"
            stats={[
              { label: "Matches", value: String(universalModelOptions.length) },
              {
                label: "Ready",
                value: String(universalModelOptions.filter((item) => item.availability === "ready").length),
              },
              {
                label: "Blocked",
                value: String(universalModelOptions.filter((item) => item.availability === "blocked").length),
              },
            ]}
          >
            <SettingsField label="Search provider or model">
              <input
                className="mc-next-settings-input"
                value={modelPickerQuery}
                onChange={(event) => setModelPickerQuery(event.target.value)}
                placeholder="gpt, claude, local, fallback, blocked"
              />
            </SettingsField>
            <SettingsActionList
              items={universalModelOptions.slice(0, 12).map((item) => ({
                id: item.id,
                label: item.label,
                description: item.availabilityReason,
                meta: [
                  item.availability,
                  item.credentialStatus,
                  item.contextWindowTokens ? `${item.contextWindowTokens.toLocaleString()} tokens` : undefined,
                  item.contextLimitSource,
                  item.endpointIdentity,
                ]
                  .filter(Boolean)
                  .join(" · "),
                actionLabel:
                  item.providerId === config?.activeProviderId && item.model === config?.activeModel
                    ? "Active"
                    : item.availability === "blocked"
                      ? "Blocked"
                      : "Select",
                onClick:
                  item.availability === "blocked"
                    ? undefined
                    : () => {
                        providerTransitionGuard.requestTransition({
                          kind: "routing",
                          providerId: item.providerId,
                          model: item.model,
                        });
                      },
              }))}
              emptyLabel="No provider models match this search."
              maxHeight="min(42vh, 24rem)"
            />
            <SettingsNotice
              notice={{
                tone: "info",
                message:
                  "Selecting here stages the provider/model in Active routing; Save routing is still required before runtime changes.",
              }}
            />
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-advice-card"
            title="Provider advice"
            subtitle="Advisory routing guidance only; no provider configuration is mutated."
            stats={[
              { label: "Candidates", value: String(providerAdvice.data?.candidates?.length ?? 0) },
              {
                label: "Mutation",
                value: providerAdvice.data?.mutationPerformed === false ? "none" : "none",
              },
            ]}
          >
            {providerAdvice.error ? <SettingsNotice notice={{ tone: "error", message: providerAdvice.error }} /> : null}
            {providerAdvice.data ? (
              <>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message: providerAdvice.data.warnings?.[0] ?? "Provider advice is advisory only.",
                  }}
                />
                <ul className="mc-next-approvals-compact-list">
                  {(providerAdvice.data.candidates ?? []).map((candidate) => (
                    <li key={`${candidate.providerId}:${candidate.model}`}>
                      <strong>
                        {candidate.providerLabel} · {candidate.model}
                      </strong>
                      <span>
                        Fit {candidate.fitScore} · Cost{" "}
                        {candidate.estimatedCostUsd === undefined
                          ? "unknown"
                          : `$${candidate.estimatedCostUsd.toFixed(4)}`}{" "}
                        · Runtime {candidate.localRuntimeFit?.fit ?? "unknown"} (
                        {candidate.measurementSource ?? "unavailable"})
                      </span>
                      <p>{candidate.riskNotes.join(" ")}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Load advisory provider recommendations to compare configured keys, estimated cost, and routing risk without changing settings.",
                }}
              />
            )}
            <SettingsButtonRow>
              <NativeButton
                variant="secondary"
                onClick={() => void handleLoadProviderAdvice()}
                disabled={providerAdvice.loading}
              >
                <Gauge size={16} />
                {providerAdvice.loading ? "Loading advice..." : "Load advice"}
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-oauth-card"
            title="OpenAI Codex ChatGPT login"
            subtitle="Connect the OpenAI Codex provider through ChatGPT OAuth. No API key needed."
            stats={[
              {
                label: "Provider",
                value: hasCodexOAuthProvider ? "Ready" : "Missing",
              },
              {
                label: "Login",
                value: codexOAuthConnected
                  ? "Connected"
                  : codexOAuthStatus?.requiresReauth
                    ? "Reauth"
                    : codexOAuthFlow
                      ? "Waiting"
                      : "Not started",
              },
            ]}
          >
            <SettingsWizardSteps steps={codexOAuthWizardSteps} />
            {hasOrphanCodexOAuthCredential ? (
              <SettingsNotice
                notice={{
                  tone: "warning",
                  message:
                    "A ChatGPT OAuth credential exists in secure storage, but the OpenAI Codex provider is missing. Add the provider to use it, or disconnect to remove the stored credential.",
                }}
              />
            ) : !hasCodexOAuthProvider ? (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Start here. GoatCitadel will add the built-in OpenAI Codex provider, then this card will switch to ChatGPT login.",
                }}
              />
            ) : codexOAuthConnected ? (
              <SettingsNotice
                notice={{
                  tone: "success",
                  message: `Done. ChatGPT OAuth is connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}.`,
                }}
              />
            ) : codexOAuthFlow ? (
              <div className="mc-next-settings-oauth-code-card">
                <span>{codexOAuthFlowUserCode ? "Use this exact OpenAI code" : "OpenAI browser login"}</span>
                <strong>{codexOAuthFlowUserCode || "Awaiting approval"}</strong>
                {codexOAuthFlowUserCode ? (
                  <p>
                    Open the OpenAI page, enter this code, approve the request, then return here. GoatCitadel checks
                    automatically{codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
                  </p>
                ) : (
                  <p>
                    Complete the OpenAI browser approval, then return here. GoatCitadel checks automatically
                    {codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
                  </p>
                )}
              </div>
            ) : (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message: "Press Start ChatGPT login. GoatCitadel will open the OpenAI approval page.",
                }}
              />
            )}
            {codexOAuthFlow ? (
              <SettingsFieldGrid>
                <SettingsField label="OpenAI page">
                  <input className="mc-next-settings-input" value={codexOAuthFlow.verificationUrl} readOnly />
                </SettingsField>
                {codexOAuthFlowUserCode ? (
                  <SettingsField label="Current code">
                    <input className="mc-next-settings-input" value={codexOAuthFlowUserCode} readOnly />
                  </SettingsField>
                ) : null}
              </SettingsFieldGrid>
            ) : null}
            <SettingsButtonRow>
              {!hasCodexOAuthProvider ? (
                <NativeButton
                  variant="default"
                  onClick={() => void handleAddChatGptOAuthProvider()}
                  disabled={providerSaveBusy}
                >
                  <KeyRound size={16} />
                  Add provider and continue
                </NativeButton>
              ) : codexOAuthFlow ? (
                <NativeButton variant="default" onClick={handleOpenCodexOAuthVerification} disabled={codexOAuthBusy}>
                  <ExternalLink size={16} />
                  Open OpenAI page
                </NativeButton>
              ) : (
                <NativeButton
                  variant="default"
                  onClick={() => void handleStartCodexOAuth(true)}
                  disabled={codexOAuthBusy}
                >
                  <KeyRound size={16} />
                  {codexOAuthConnected ? "Reconnect ChatGPT" : "Start ChatGPT login"}
                </NativeButton>
              )}
              {codexOAuthFlow ? (
                <NativeButton variant="secondary" onClick={() => void handlePollCodexOAuth()} disabled={codexOAuthBusy}>
                  <RefreshCw size={16} />I approved, check now
                </NativeButton>
              ) : null}
              {codexOAuthFlow ? (
                <NativeButton
                  variant="secondary"
                  onClick={() => void handleRestartCodexOAuth()}
                  disabled={codexOAuthBusy}
                >
                  <RotateCcw size={16} />
                  {codexOAuthFlowUserCode ? "Get a new code" : "Restart login"}
                </NativeButton>
              ) : null}
              {hasCodexOAuthProvider && !codexOAuthFlow ? (
                <NativeButton variant="secondary" onClick={handleShowCodexOAuthProviderDetail}>
                  <SlidersHorizontal size={16} />
                  Advanced details
                </NativeButton>
              ) : null}
              {hasCodexOAuthCredential ? (
                <NativeButton
                  variant="secondary"
                  onClick={() => void handleDisconnectCodexOAuth()}
                  disabled={codexOAuthBusy}
                >
                  <Trash2 size={16} />
                  Disconnect
                </NativeButton>
              ) : null}
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-detail-card"
            title={selectedProvider?.label ?? "Provider detail"}
            subtitle="Credential posture, probe state, and read-only runtime trust signals."
          >
            {selectedProvider ? (
              <>
                <NativeMetricGrid
                  items={[
                    { label: "Default model", value: selectedProvider.defaultModel, meta: "Configured fallback" },
                    {
                      label: "Configured API",
                      value: selectedProvider.apiStyle,
                      meta: "Saved provider setting",
                    },
                    {
                      label: "Execution API",
                      value: selectedProviderExecutionApiStyle ?? selectedProvider.apiStyle,
                      meta: selectedProviderApiMeta,
                    },
                    {
                      label:
                        selectedProviderIsCodexOAuth || selectedProviderIsClaudeCodeOAuth
                          ? "OAuth"
                          : selectedProviderIsGoogleAdc
                            ? "Google ADC"
                            : selectedProviderIsGoogleServiceAccount
                              ? "Service account"
                              : "API key",
                      value: selectedProviderIsCodexOAuth
                        ? codexOAuthStatus?.connected
                          ? "Connected"
                          : codexOAuthStatus?.requiresReauth
                            ? "Reauth"
                            : "Missing"
                        : selectedProviderIsGoogleAdc
                          ? selectedProvider.hasApiKey
                            ? "Configured"
                            : selectedProvider.authReadiness?.status === "invalid"
                              ? "Invalid"
                              : selectedProvider.authReadiness?.status === "unavailable"
                                ? "Unavailable"
                                : selectedProvider.authReadiness?.status === "missing"
                                  ? "Missing"
                                  : "Unknown"
                          : selectedProviderIsClaudeCodeOAuth
                            ? secretState.data?.hasSecret || selectedProvider.hasApiKey
                              ? "Configured"
                              : "Missing"
                            : secretState.data?.hasSecret || selectedProvider.hasApiKey
                              ? "Configured"
                              : "Missing",
                      meta: selectedProviderIsCodexOAuth
                        ? (codexOAuthStatus?.accountLabel ?? "ChatGPT/Codex plan")
                        : selectedProviderIsGoogleAdc
                          ? formatGoogleAdcReadinessMeta(selectedProvider.authReadiness)
                          : selectedProviderIsGoogleServiceAccount
                            ? "Gateway-owned service-account JSON secret"
                            : selectedProviderIsClaudeCodeOAuth
                              ? "Claude subscription token"
                              : formatSecretStatusMeta(
                                  secretState.data?.source ?? selectedProvider.apiKeySource,
                                  secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
                                ),
                    },
                    {
                      label: "Secret source",
                      value: selectedProviderIsGoogleAdc
                        ? formatGoogleAuthSourceLabel(selectedProvider.authReadiness?.source)
                        : formatEffectiveConfigSourceLabel(secretState.data?.source ?? selectedProvider.apiKeySource),
                      meta: "Effective source label",
                    },
                    {
                      label: "Probe",
                      value: formatProviderProbeStateLabel(selectedProvider.modelProbeState),
                      meta:
                        selectedProvider.modelProbeSource === "error_fallback"
                          ? "Fallback after probe error; inspect model discovery below"
                          : selectedProvider.modelProbeState === "error"
                            ? "Live discovery failed; inspect model discovery below"
                            : formatProviderProbeSourceMeta(selectedProvider),
                    },
                    {
                      label: "Provider models",
                      value: String(availableModels.length),
                      meta: formatProviderModelsMeta(selectedProvider, availableModels.length),
                    },
                    {
                      label: "Runtime posture",
                      value: selectedProviderRuntimePosture,
                      meta: selectedProviderIsLocal ? "Local endpoint detected" : "Network endpoint detected",
                    },
                  ]}
                />
                <SettingsFieldGrid>
                  <SettingsField label="Base URL">
                    <input className="mc-next-settings-input" value={selectedProvider.baseUrl} readOnly />
                  </SettingsField>
                  <SettingsField label="Capabilities">
                    <input
                      className="mc-next-settings-input"
                      value={formatCapabilities(selectedProvider.capabilities)}
                      readOnly
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsActionList
                  items={selectedProviderSmokeEvidenceItems.map((item) => ({
                    ...item,
                    onClick:
                      item.id === "model-discovery" || item.id === "provider-smoke"
                        ? () => void handleRefreshModels(selectedProvider.providerId)
                        : item.id === "transport"
                          ? () => setEditorMode("selected")
                          : undefined,
                  }))}
                  maxHeight=""
                />
                {selectedProviderIsCodexOAuth ? (
                  <>
                    <SettingsNotice
                      notice={{
                        tone: codexOAuthConnected ? "success" : "info",
                        message: codexOAuthConnected
                          ? `OpenAI Codex OAuth connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}.`
                          : codexOAuthFlow
                            ? "ChatGPT login is currently in progress in the setup card above."
                            : "No API key goes here. ChatGPT login is managed by the setup card above.",
                      }}
                    />
                    <SettingsButtonRow>
                      <NativeButton
                        variant="secondary"
                        onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                        disabled={providerProbeBusyId === selectedProvider.providerId}
                      >
                        <RefreshCw size={16} />
                        {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                      </NativeButton>
                    </SettingsButtonRow>
                  </>
                ) : selectedProviderIsGoogleAdc ? (
                  <>
                    <SettingsNotice
                      notice={{
                        tone: "info",
                        message:
                          "Vertex AI uses Gateway-local Application Default Credentials. Credential files, refresh tokens, access tokens, and metadata tokens never roundtrip to Mission Control.",
                      }}
                    />
                    <SettingsButtonRow>
                      <NativeButton
                        variant="secondary"
                        onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                        disabled={providerProbeBusyId === selectedProvider.providerId}
                      >
                        <RefreshCw size={16} />
                        {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Validate ADC & models"}
                      </NativeButton>
                    </SettingsButtonRow>
                  </>
                ) : (
                  <>
                    <SettingsField
                      label={selectedProviderIsGoogleServiceAccount ? "Service-account JSON" : "Provider secret"}
                    >
                      <input
                        className="mc-next-settings-input"
                        type="password"
                        value={secretValue}
                        placeholder={
                          selectedProviderIsGoogleServiceAccount
                            ? "Paste service-account JSON to replace the Gateway-owned secret"
                            : "Paste a new API key to save"
                        }
                        onChange={(event) => setSecretValue(event.target.value)}
                      />
                    </SettingsField>
                    <SettingsNotice
                      notice={{
                        tone: "info",
                        message: selectedProviderIsGoogleServiceAccount
                          ? "The JSON credential is sent only to the Gateway secret owner and never returned, projected into provider config, or written into public diagnostics. This field only accepts a replacement credential."
                          : "Key on file status comes from the gateway only. Saved key values do not roundtrip back to the browser; status only reports whether a key exists and whether it is stored in OS keychain, local .env fallback, inline config, or none. This field only accepts a replacement key.",
                      }}
                    />
                    {secretState.error ? (
                      <SettingsNotice notice={{ tone: "error", message: secretState.error }} />
                    ) : null}
                    <SettingsButtonRow>
                      <NativeButton variant="default" onClick={() => void handleSaveSecret()}>
                        <KeyRound size={16} />
                        Save secret
                      </NativeButton>
                      <NativeButton
                        variant="secondary"
                        onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                        disabled={providerProbeBusyId === selectedProvider.providerId}
                      >
                        <RefreshCw size={16} />
                        {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                      </NativeButton>
                      <NativeButton
                        variant="destructive"
                        onClick={() =>
                          selectedProviderId.trim()
                            ? setPendingDeleteSecret({
                                providerId: selectedProviderId,
                                label: selectedProvider?.label ?? selectedProviderId,
                              })
                            : undefined
                        }
                      >
                        <Trash2 size={16} />
                        Delete secret
                      </NativeButton>
                    </SettingsButtonRow>
                  </>
                )}
              </>
            ) : (
              <SettingsEmptyState label="Choose a provider to inspect routing and secret posture." />
            )}
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel mc-next-provider-editor-card"
            title="Provider editor"
            subtitle={editorHint}
          >
            <SettingsFieldGrid>
              <SettingsField label="Provider id">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.providerId}
                  placeholder="openai-compatible"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      providerId: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="Label">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.label}
                  placeholder="OpenAI-compatible"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="Base URL">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.baseUrl}
                  placeholder="https://llm.example.test/v1"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="Provider API style">
                <select
                  className="mc-next-settings-input"
                  value={providerDraft.apiStyle}
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      apiStyle: event.target.value as ProviderEditorDraft["apiStyle"],
                    }))
                  }
                >
                  {PROVIDER_API_STYLE_OPTIONS.map((style) => (
                    <option key={style} value={style}>
                      {formatProviderApiStyleLabel(style)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">{describeProviderApiStyle(providerDraft.apiStyle)}</p>
                {providerApiStyleWarning ? (
                  <p className="mc-next-settings-field-note">{providerApiStyleWarning}</p>
                ) : null}
              </SettingsField>
              <SettingsField label="Credential mode">
                <select
                  className="mc-next-settings-input"
                  value={draftIsCodexOAuth ? "codex-oauth" : providerDraft.authMode}
                  disabled={draftIsCodexOAuth}
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      authMode: event.target.value as ProviderEditorDraft["authMode"],
                    }))
                  }
                >
                  <option value="">Provider default</option>
                  <option value="api-key">API key</option>
                  <option value="google-adc">Google ADC</option>
                  <option value="google-service-account">Google service account</option>
                  <option value="claude-code-oauth">Claude Code OAuth token</option>
                  <option value="codex-oauth">ChatGPT/Codex OAuth</option>
                </select>
                <p className="mc-next-settings-field-note">
                  Google credential contents remain Gateway-local; this field stores only the auth posture.
                </p>
              </SettingsField>
              <SettingsField label="Default model">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.defaultModel}
                  placeholder="gpt-5.4-mini"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              {draftIsCodexOAuth || providerDraft.authMode === "google-adc" ? null : (
                <SettingsField
                  label={
                    providerDraft.authMode === "google-service-account" ? "Service-account JSON env" : "API key env"
                  }
                >
                  <input
                    className="mc-next-settings-input"
                    value={providerDraft.apiKeyEnv}
                    placeholder="OPENAI_API_KEY"
                    onChange={(event) =>
                      setProviderDraft((current) => ({
                        ...current,
                        apiKeyEnv: event.target.value,
                      }))
                    }
                  />
                </SettingsField>
              )}
              {draftUsesGoogleAuth ? (
                <>
                  <SettingsField label="Google Cloud project">
                    <input
                      className="mc-next-settings-input"
                      value={providerDraft.googleProjectId}
                      placeholder="my-project"
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, googleProjectId: event.target.value }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Project env name">
                    <input
                      className="mc-next-settings-input"
                      value={providerDraft.googleProjectIdEnv}
                      placeholder="GOOGLE_CLOUD_PROJECT"
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, googleProjectIdEnv: event.target.value }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Vertex location">
                    <input
                      className="mc-next-settings-input"
                      value={providerDraft.googleLocation}
                      placeholder="us-central1"
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, googleLocation: event.target.value }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Location env name">
                    <input
                      className="mc-next-settings-input"
                      value={providerDraft.googleLocationEnv}
                      placeholder="GOOGLE_CLOUD_LOCATION"
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, googleLocationEnv: event.target.value }))
                      }
                    />
                  </SettingsField>
                  <SettingsField label="Vertex endpoint id">
                    <input
                      className="mc-next-settings-input"
                      value={providerDraft.googleEndpointId}
                      placeholder="openapi"
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, googleEndpointId: event.target.value }))
                      }
                    />
                  </SettingsField>
                </>
              ) : null}
            </SettingsFieldGrid>
            {providerRequestValidation.error ? (
              <SettingsNotice notice={{ tone: "error", message: providerRequestValidation.error }} />
            ) : null}
            <LlmTransportFields
              draft={providerTransportDraft}
              idPrefix={`provider-editor-${providerDraft.providerId || "draft"}`}
              onChange={setProviderTransportDraft}
              error={providerRequestValidation.error}
            />
            <SettingsButtonRow>
              <NativeButton variant="default" disabled={providerSaveBusy} onClick={() => void handleSaveProvider()}>
                <Save size={16} />
                {providerSaveBusy ? "Saving..." : "Save provider"}
              </NativeButton>
              <NativeButton
                variant="secondary"
                onClick={() =>
                  selectedProvider
                    ? handleRefreshModels(selectedProvider.providerId)
                    : handleRefreshModels(providerDraft.providerId)
                }
                disabled={
                  providerProbeBusyId === selectedProvider?.providerId ||
                  providerProbeBusyId === providerDraft.providerId
                }
              >
                <RefreshCw size={16} />
                {providerProbeBusyId === selectedProvider?.providerId ||
                providerProbeBusyId === providerDraft.providerId
                  ? "Probing..."
                  : "Probe from editor"}
              </NativeButton>
              <NativeButton
                variant="secondary"
                onClick={() => {
                  const nextProviderDraft = buildProviderEditorDraft(selectedProviderConfig ?? selectedProvider);
                  const nextTransportDraft = draftFromRequestConfig(selectedProviderConfig?.request);
                  setEditorMode("selected");
                  setProviderDraft(nextProviderDraft);
                  setProviderBaselineDraft(nextProviderDraft);
                  setProviderTransportDraft(nextTransportDraft);
                  setProviderTransportBaselineDraft(nextTransportDraft);
                }}
                disabled={!selectedProvider}
              >
                <RotateCcw size={16} />
                Reload selected
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
        </SettingsStack>
      </SettingsGrid>
      <ConfirmModal
        open={providerTransitionGuard.pendingTransition !== null}
        danger
        title="Discard provider changes?"
        message="The selected provider has unsaved edits. Discard them and continue?"
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onCancel={providerTransitionGuard.cancelDiscard}
        onConfirm={providerTransitionGuard.confirmDiscard}
      />
      <ConfirmModal
        open={pendingDeleteSecret !== null}
        danger
        pending={deleteSecretBusy}
        title="Delete provider secret?"
        message={`Delete the saved secret for ${pendingDeleteSecret?.label ?? "this provider"}? This cannot be undone.`}
        confirmLabel="Delete secret"
        onCancel={() => setPendingDeleteSecret(null)}
        onConfirm={() => void handleDeleteSecret()}
      />
    </SettingsSectionShell>
  );
}

function formatProviderApiStyleLabel(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "OpenAI Responses";
  }
  if (value === "openai-codex-responses") {
    return "OpenAI Codex Responses";
  }
  if (value === "anthropic-messages") {
    return "Anthropic Messages";
  }
  return "OpenAI Chat Completions";
}

function describeProviderApiStyle(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "Use for modern OpenAI-compatible Responses endpoints with tool and reasoning support.";
  }
  if (value === "openai-codex-responses") {
    return "Use only for the built-in ChatGPT/Codex OAuth provider.";
  }
  if (value === "anthropic-messages") {
    return "Use for Anthropic Claude providers that speak the Messages API.";
  }
  return "Use for older OpenAI-compatible chat-completions endpoints such as many proxy or local servers.";
}

function formatSecretStatusMeta(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key on file";
  }
  if (source === "keychain") {
    return "Key on file in OS keychain";
  }
  if (source === "env") {
    return "Key on file in local .env fallback";
  }
  if (source === "inline") {
    return "Key on file in inline config";
  }
  return "Key on file; value is never returned";
}

function formatGoogleAdcReadinessMeta(readiness: ProviderModelCatalogOption["authReadiness"]): string {
  if (!readiness) {
    return "Gateway-local ADC readiness has not been inspected";
  }
  const source = formatGoogleAuthSourceLabel(readiness.source);
  if (readiness.status === "ready" && readiness.liveVerified) {
    return `${source}; live credential resolved by Gateway`;
  }
  if (readiness.status === "configured") {
    return `${source}; supported credential shape found, live token not claimed`;
  }
  return `${source}; ${readiness.status.replaceAll("_", " ")} (${readiness.reasonCode})`;
}

function formatGoogleAuthSourceLabel(
  source: NonNullable<ProviderModelCatalogOption["authReadiness"]>["source"] | undefined,
): string {
  if (source === "adc_file") return "ADC file";
  if (source === "metadata") return "Google metadata service";
  if (source === "keychain") return "secure store";
  if (source === "env") return "environment";
  return "no credential source";
}

function formatSecretStorageNotice(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key remains on file.";
  }
  if (source === "keychain") {
    return "Stored in OS keychain.";
  }
  if (source === "env") {
    return "Stored in local .env fallback.";
  }
  if (source === "inline") {
    return "Stored in inline config.";
  }
  return "Stored by gateway secret backend.";
}
