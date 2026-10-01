import { ProviderTrustPanel } from "./ProviderTrustPanel";
import { ProviderOAuthPanel } from "./ProviderOAuthPanel";
import { useProviderOAuthFlow } from "./use-provider-oauth-flow";
import { useProviderProfileEditor } from "./use-provider-profile-editor";
import { useProviderCredentials } from "./use-provider-credentials";
import { useProviderRouting } from "./use-provider-routing";
import { useProviderCodexSetup } from "./use-provider-codex-setup";
import { useProviderPlanActions } from "./use-provider-plan-actions";
import { ProviderRoutingPanel } from "./ProviderRoutingPanel";
import { ProviderProfileFields } from "./ProviderProfileFields";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ProviderAdvicePanel } from "./ProviderAdvicePanel";
import { useProviderAdvice } from "./use-provider-advice";
import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, RefreshCw, RotateCcw, Save } from "lucide-react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { presentProviderReadiness } from "@goatcitadel/mission-control-shared/content/provider-readiness";
import {
  buildUniversalModelPickerOptions,
  useProviderModelCatalog,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsGrid,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { SettingsChangeStatus } from "../use-settings-change";
import { hasSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { formatProviderCredentialLabel, formatProviderProbeStateLabel } from "../helpers/provider-format";

type ProviderEditorTransition =
  | { kind: "select"; providerId: string }
  | { kind: "new" }
  | { kind: "routing"; providerId: string; model?: string };

export function ProvidersSection({ activeWorkspaceId, navigate, route }: SettingsSectionProps) {
  const { config, providers, loading, error, reload, loadModelsForProvider, getCachedModelProbe } =
    useProviderModelCatalog("system");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [detailView, setDetailView] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [credentialEditorOpen, setCredentialEditorOpen] = useState(false);
  const leave = useDraftLeave();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [providerProbeBusyId, setProviderProbeBusyId] = useState<string | null>(null);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const { state: providerAdvice, load: handleLoadProviderAdvice } = useProviderAdvice();
  const providerConfigMap = useMemo(
    () => new Map((config?.providerConfigs ?? []).map((provider) => [provider.providerId, provider] as const)),
    [config?.providerConfigs],
  );
  const codexOAuthProvider = providers.find((item) => item.providerId === "openai-codex") ?? null;
  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? providers[0] ?? null;
  const selectedProviderConfig = selectedProvider ? providerConfigMap.get(selectedProvider.providerId) : undefined;
  const profile = useProviderProfileEditor({
    config,
    reload,
    loadModelsForProvider,
    selectedProviderId,
    selectedProvider,
    selectedProviderConfig,
    editorMode,
    detailView,
    setNotice,
    onSaved: (providerId) => {
      setEditorMode("selected");
      setSelectedProviderId(providerId);
      setDetailView("trust");
    },
  });
  const {
    providerEditor,
    providerDraft,
    providerTransportDraft,
    setProviderDraft,
    setProviderTransportDraft,
    providerChange,
    providerRequestValidation,
    providerSaveBusy,
    currentEditor,
    handleSaveProvider,
  } = profile;
  const routing = useProviderRouting({ config, providers, reload, active: detailView === "routing", setNotice });
  const { routingEditor, routingChange, routingProviderId, setRoutingProviderId, setRoutingModel, persistRouting } =
    routing;
  const credentials = useProviderCredentials({
    config,
    reload,
    selectedProviderId,
    detailView,
    credentialEditorOpen,
    currentEditor,
    setNotice,
  });
  const {
    secretEditor,
    secretChange,
    secretRemoval,
    pendingDeleteSecret,
    setPendingDeleteSecret,
    deleteSecretBusy,
    handleDeleteSecret,
  } = credentials;
  const codexSetup = useProviderCodexSetup({
    config,
    reload,
    loadModelsForProvider,
    setNotice,
    viewIdentity: { activeWorkspaceId, detailView },
    onSaved: () => {
      setEditorMode("selected");
      setSelectedProviderId("openai-codex");
    },
  });
  const routingDirty = routingEditor.isDirty;
  const editorKeys = [providerEditor.key, secretEditor.key];
  const providerIdsKey = providers.map((provider) => provider.providerId).join("\u0000");
  const hasCodexOAuthProvider = Boolean(codexOAuthProvider);
  const oauth = useProviderOAuthFlow({ activeWorkspaceId, hasCodexOAuthProvider, setNotice });
  const {
    codexOAuthStatus,
    setCodexOAuthPlan,
    codexOAuthPlanDialog,
    setCodexOAuthPlanDialog,
    codexOAuthBusy,
    codexOAuthConnected,
    refreshCodexOAuthStatus,
    handleStartCodexOAuth,
  } = oauth;
  const planActions = useProviderPlanActions({
    plan: codexOAuthPlanDialog,
    setPlan: setCodexOAuthPlanDialog,
    setNotice,
    viewIdentity: { activeWorkspaceId, selectedProviderId, detailView },
    onAcknowledged: (next) => {
      if (next.request.kind === "provider_connection" && next.request.providerId === "openai-codex")
        setCodexOAuthPlan(next);
    },
    onSettled: async () => {
      await Promise.all([
        providerChange.refresh(),
        secretChange.refresh(),
        routingChange.refresh(),
        codexSetup.refresh(),
        secretRemoval.refresh(),
      ]);
      await reload();
      await refreshCodexOAuthStatus();
    },
  });
  const codexRoutingModel = codexOAuthProvider?.defaultModel || codexOAuthProvider?.models?.[0] || "";
  const editorHint =
    editorMode === "new"
      ? "Create a new provider definition without expanding the gateway."
      : "Edit the selected provider through runtime settings. Secrets stay on the secure secret endpoints.";
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

  const applyProviderTransition = (transition: ProviderEditorTransition) => {
    setAddProviderOpen(false);
    setCredentialEditorOpen(false);
    if (transition.kind === "new") {
      setEditorMode("new");
      setDetailView("editor");
      return;
    }
    if (transition.kind === "routing") {
      const next = providers.find((item) => item.providerId === transition.providerId);
      const suggestedModel =
        next?.modelProbeSource === "live" && next.modelRefreshStatus === "fresh"
          ? next.models.includes(next.defaultModel)
            ? next.defaultModel
            : ""
          : (next?.defaultModel ?? next?.models?.[0] ?? "");
      routingEditor.setValue({ providerId: transition.providerId, model: transition.model ?? suggestedModel });
      setDetailView("routing");
      return;
    }
    setEditorMode("selected");
    setSelectedProviderId(transition.providerId);
    setDetailView("trust");
  };
  const providerTransitionGuard = {
    requestTransition: (transition: ProviderEditorTransition) =>
      leave.request(() => applyProviderTransition(transition), editorKeys),
  };
  const openView = (view: string | null) =>
    leave.request(() => {
      setAddProviderOpen(false);
      setDetailView(view);
    });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = (window.location?.hash ?? "").slice(1).replace("providers-", "");
    if (["routing", "models", "advice", "oauth", "trust", "editor"].includes(target)) setDetailView(target);
  }, []);

  useEffect(() => {
    if (!providers.length) {
      setSelectedProviderId("");
      return;
    }
    setSelectedProviderId((current) => current || config?.activeProviderId || providers[0]?.providerId || "");
  }, [config?.activeProviderId, providers]);

  useEffect(() => {
    if (detailView === "models") {
      void Promise.all(
        providerIdsKey
          .split("\u0000")
          .filter(Boolean)
          .map((providerId) => loadModelsForProvider(providerId)),
      );
    } else if (detailView === "routing" && routingProviderId) {
      void loadModelsForProvider(routingProviderId);
    } else if (detailView && selectedProviderId) {
      void loadModelsForProvider(selectedProviderId);
    }
  }, [loadModelsForProvider, selectedProviderId, routingProviderId, providerIdsKey, detailView]);

  useEffect(() => {
    if (detailView !== "models" && detailView !== "routing") return;
    const timer = globalThis.setInterval(() => {
      const providerIds =
        detailView === "models" ? providerIdsKey.split("\u0000").filter(Boolean) : [routingProviderId];
      void Promise.all(providerIds.filter(Boolean).map((providerId) => loadModelsForProvider(providerId)));
    }, 60_000);
    return () => globalThis.clearInterval(timer);
  }, [detailView, loadModelsForProvider, providerIdsKey, routingProviderId]);

  const handleUseCodexForChat = async () => {
    if (!codexOAuthConnected) {
      setNotice({ tone: "warning", message: "Connect ChatGPT before activating OpenAI Codex for Chat." });
      return;
    }
    if (!codexRoutingModel) {
      setNotice({ tone: "warning", message: "Refresh OpenAI Codex models before activating it for Chat." });
      return;
    }
    setRoutingProviderId("openai-codex");
    setRoutingModel(codexRoutingModel);
    await persistRouting("openai-codex", codexRoutingModel);
  };

  const handleAddChatGptOAuthProvider = async () => {
    setDetailView("oauth");
    if (hasCodexOAuthProvider) {
      setEditorMode("selected");
      setSelectedProviderId("openai-codex");
      setNotice({ tone: "info", message: "OpenAI Codex is already configured. Connect ChatGPT OAuth below." });
      return;
    }
    await codexSetup.add();
  };
  const handleStartNewProviderDraft = () => {
    if (editorMode === "new") {
      setDetailView("editor");
      return;
    }
    providerTransitionGuard.requestTransition({ kind: "new" });
  };

  const handleShowCodexOAuthProviderDetail = () =>
    providerTransitionGuard.requestTransition({ kind: "select", providerId: "openai-codex" });

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
      const staleLiveCatalog = probe?.source === "live" && probe.expiresAt <= Date.now();
      setNotice({
        tone: items.length > 0 && !fallbackOnly && !failedProbe && !staleLiveCatalog ? "success" : "warning",
        message: staleLiveCatalog
          ? `Showing ${items.length} last known model${items.length === 1 ? "" : "s"} for ${normalized}; live discovery did not verify this catalog${probe?.warning ? `: ${probe.warning}` : "."}`
          : failedProbe
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
    <SettingsSectionShell loading={loading && !config} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {profile.mutation.uncertain ? (
        <SettingsNotice notice={{ tone: "error", message: profile.mutation.uncertain }} />
      ) : null}

      <SettingsGrid className="mc-next-calm-directory">
        {detailView !== "editor" ? (
          <NativeCard
            id="providers-directory"
            density="compact"
            className="mc-next-settings-panel mc-next-provider-directory"
            title="Provider profiles"
            subtitle="Available providers, probe posture, and current catalog coverage."
            stats={[
              { label: "Provider profiles", value: String(providers.length) },
              { label: "Active workspace", value: activeWorkspaceId, technical: true },
            ]}
          >
            <p className="mc-next-settings-copy">
              <strong>Default model</strong> ·{" "}
              {providers.find((item) => item.providerId === config?.activeProviderId)?.label ??
                config?.activeProviderId ??
                "Unavailable"}{" "}
              · {config?.activeModel || "Not selected"}
            </p>
            <SettingsButtonRow>
              <NativeButton
                aria-expanded={addProviderOpen}
                aria-controls="provider-creation-options"
                onClick={() => setAddProviderOpen((open) => !open)}
              >
                Add provider{hasSessionDraft("provider:system:new") ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton variant="outline" onClick={() => openView("routing")}>
                Default routing{routingDirty ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton variant="outline" onClick={() => openView("models")}>
                Browse models
              </NativeButton>
              <NativeButton
                variant="outline"
                onClick={() =>
                  navigate({ area: "settings", section: "onboarding", view: "llamacpp", theme: route.theme })
                }
              >
                Set up llama.cpp
              </NativeButton>
            </SettingsButtonRow>
            <div id="provider-creation-options" hidden={!addProviderOpen}>
              <SettingsButtonRow>
                <NativeButton onClick={() => navigate({ area: "settings", section: "onboarding", theme: route.theme })}>
                  Guided setup
                </NativeButton>
                <NativeButton variant="outline" onClick={() => openView("oauth")} disabled={providerSaveBusy}>
                  <KeyRound size={16} />
                  {hasCodexOAuthProvider ? "ChatGPT setup" : "Add ChatGPT setup"}
                </NativeButton>
                <NativeButton variant="secondary" onClick={handleStartNewProviderDraft}>
                  <Plus size={16} />
                  Custom provider{hasSessionDraft("provider:system:new") ? " · Unsaved" : ""}
                </NativeButton>
              </SettingsButtonRow>
            </div>
            <NativeSelectableList
              items={providers.map((item) => ({
                id: item.providerId,
                title: `${item.label}${hasSessionDraft(`provider:system:${item.providerId}`) || hasSessionDraft(`provider-secret:system:${item.providerId}`) ? " · Unsaved" : ""}`,
                status: presentProviderReadiness(item),
                body: [
                  `${item.models.length} ${item.models.length === 1 ? "model" : "models"}`,
                  formatProviderCredentialLabel(item.providerId, item.hasApiKey, codexOAuthStatus),
                  formatProviderProbeStateLabel(item.modelProbeState),
                ].join(" · "),
              }))}
              selectedId={selectedProviderId}
              onSelect={(providerId) => {
                if (editorMode === "selected" && providerId === selectedProviderId && detailView === "trust") return;
                providerTransitionGuard.requestTransition({ kind: "select", providerId });
              }}
              emptyLabel="No providers returned from runtime settings."
              maxHeight="min(44vh, 25rem)"
            />
            <NativeDisclosureCard id="provider-tools" title="Provider tools">
              <NativeButton variant="ghost" onClick={() => openView("advice")}>
                Provider advice
              </NativeButton>
            </NativeDisclosureCard>
          </NativeCard>
        ) : null}
        <SettingsStack className="mc-next-provider-detail-stack">
          <DetailInspector open={detailView === "routing"} title="Default routing" onClose={() => openView(null)}>
            <ProviderRoutingPanel
              routing={routing}
              providers={providers}
              config={config}
              route={route}
              navigate={navigate}
              onSelectProvider={(providerId) =>
                providerTransitionGuard.requestTransition({ kind: "routing", providerId })
              }
            />
          </DetailInspector>
          <DetailInspector open={detailView === "models"} title="Model picker" onClose={() => openView(null)}>
            <ProviderModelPicker
              providers={providers}
              universalModelOptions={universalModelOptions}
              activeProviderId={config?.activeProviderId}
              activeModel={config?.activeModel}
              modelPickerQuery={modelPickerQuery}
              setModelPickerQuery={setModelPickerQuery}
              onSetupLlamaCpp={() =>
                navigate({ area: "settings", section: "onboarding", view: "llamacpp", theme: route.theme })
              }
              onSelect={(selection) => providerTransitionGuard.requestTransition({ kind: "routing", ...selection })}
            />
          </DetailInspector>
          <DetailInspector open={detailView === "advice"} title="Provider advice" onClose={() => openView(null)}>
            <ProviderAdvicePanel providerAdvice={providerAdvice} onLoad={() => void handleLoadProviderAdvice()} />
          </DetailInspector>
          <DetailInspector open={detailView === "oauth"} title="ChatGPT login" onClose={() => openView(null)}>
            <ProviderOAuthPanel
              oauth={oauth}
              codexSetup={codexSetup}
              config={config}
              hasCodexOAuthProvider={hasCodexOAuthProvider}
              codexRoutingModel={codexRoutingModel}
              providerSaveBusy={providerSaveBusy}
              handleUseCodexForChat={handleUseCodexForChat}
              handleAddChatGptOAuthProvider={handleAddChatGptOAuthProvider}
              handleShowCodexOAuthProviderDetail={handleShowCodexOAuthProviderDetail}
              activeWorkspaceId={activeWorkspaceId}
              route={route}
              navigate={navigate}
              setNotice={setNotice}
            />
          </DetailInspector>
          <DetailInspector
            open={detailView === "trust"}
            title={selectedProvider?.label ?? "Provider details"}
            onClose={() => openView(null)}
          >
            <ProviderTrustPanel
              selectedProviderId={selectedProviderId}
              selectedProvider={selectedProvider}
              selectedProviderConfig={selectedProviderConfig}
              credentials={credentials}
              oauth={oauth}
              profileDirty={providerEditor.isDirty}
              credentialEditorOpen={credentialEditorOpen}
              onToggleCredential={() =>
                credentialEditorOpen
                  ? leave.request(() => setCredentialEditorOpen(false), [secretEditor.key])
                  : setCredentialEditorOpen(true)
              }
              providerProbeBusyId={providerProbeBusyId}
              handleRefreshModels={handleRefreshModels}
              openView={openView}
              route={route}
              navigate={navigate}
            />
          </DetailInspector>
          {detailView === "editor" ? (
            <FocusedDetail
              title={editorMode === "new" ? "Custom provider" : `Edit ${selectedProvider?.label ?? "provider"}`}
              onClose={() => openView(null)}
            >
              <NativeCard
                id="providers-editor"
                density="compact"
                className="mc-next-settings-panel mc-next-provider-editor-card"
                title="Provider editor"
                subtitle={editorHint}
              >
                <SettingsChangeStatus
                  change={providerChange.change}
                  onRefresh={providerChange.refresh}
                  route={route}
                  navigate={navigate}
                  onReview={setCodexOAuthPlanDialog}
                />
                {providerEditor.hasRemoteChanges ? (
                  <SettingsNotice
                    notice={{
                      tone: "warning",
                      message: "Settings changed after this draft began. Review the current provider before retrying.",
                    }}
                  />
                ) : null}
                {providerEditor.hasRemoteChanges ? (
                  <NativeButton variant="outline" onClick={providerEditor.rebaseToCurrent}>
                    Apply draft to current settings
                  </NativeButton>
                ) : null}
                {providerEditor.value.governedCreation ? <p className="mc-next-settings-copy">
                  Retained credential storage choice: {providerEditor.value.credentialStorage === "env"
                    ? `plaintext in this installation's environment file (${providerDraft.apiKeyEnv}). Anyone who can read that file can read the credential.`
                    : "OS keychain. A keychain failure will not fall back to an environment file."}
                  {" "}Saving prepares the same governed profile setup for explicit confirmation.
                </p> : null}
                <ProviderProfileFields
                  providerDraft={providerDraft}
                  setProviderDraft={setProviderDraft}
                  providerTransportDraft={providerTransportDraft}
                  setProviderTransportDraft={setProviderTransportDraft}
                  providerRequestValidation={providerRequestValidation}
                />
                {profile.saveOperationError ? (
                  <SettingsNotice notice={{ tone: "warning", message: profile.saveOperationError }} />
                ) : null}
                <SettingsButtonRow>
                  <NativeButton
                    variant="default"
                    disabled={
                      providerSaveBusy ||
                      providerChange.hasPending ||
                      profile.mutation.pending ||
                      Boolean(profile.mutation.uncertain)
                    }
                    onClick={() => void handleSaveProvider()}
                  >
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
                      leave.request(() => {
                        providerEditor.discard();
                        setEditorMode("selected");
                      });
                    }}
                    disabled={!selectedProvider}
                  >
                    <RotateCcw size={16} />
                    Reload selected
                  </NativeButton>
                </SettingsButtonRow>
              </NativeCard>
            </FocusedDetail>
          ) : null}
        </SettingsStack>
      </SettingsGrid>
      {leave.dialog}
      <ConfirmModal
        open={pendingDeleteSecret !== null}
        danger
        pending={deleteSecretBusy}
        confirmDisabled={
          profile.mutation.pending ||
          Boolean(profile.mutation.uncertain) ||
          pendingDeleteSecret?.revision !== config?.revision
        }
        title="Delete provider secret?"
        message={`Delete the saved secret for ${pendingDeleteSecret?.label ?? "this provider"}? This cannot be undone.`}
        confirmLabel="Delete secret"
        onCancel={() => setPendingDeleteSecret(null)}
        onConfirm={() => void handleDeleteSecret()}
      />
      <ChatChangePlanActionDialog
        plan={codexOAuthPlanDialog}
        pending={codexOAuthBusy || planActions.mutation.pending || Boolean(planActions.mutation.uncertain)}
        onClose={() => setCodexOAuthPlanDialog(null)}
        onConfirm={planActions.confirm}
        onSubmitPublicForm={() => undefined}
        onSubmitSecureInput={planActions.secure}
        onContinueOAuth={(plan) => handleStartCodexOAuth(true, plan)}
        onOpenApproval={(plan) => {
          if (plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId) {
            setCodexOAuthPlanDialog(null);
            navigate({
              area: "ops",
              section: "approvals",
              approvalId: plan.requiredAction.approvalId,
              theme: route.theme,
            });
          } else setNotice({ tone: "warning", message: "The canonical approval is not available yet." });
        }}
        onReviewArtifacts={() => undefined}
        onOpenNativePathPicker={() => undefined}
      />
    </SettingsSectionShell>
  );
}
