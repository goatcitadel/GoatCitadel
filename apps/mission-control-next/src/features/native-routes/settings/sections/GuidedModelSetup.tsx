import { useSessionDraft } from "../../library/session-drafts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Save } from "lucide-react";
import type { ChatThinkingLevel, ChangePlanRecord, OnboardingState } from "@goatcitadel/contracts";
import {
  cancelChangePlan,
  completeChangePlanProviderOAuth,
  completeOnboarding,
  confirmChangePlan,
  createChangePlan,
  fetchChangePlans,
  pollChangePlanProviderOAuth,
  respondToChangePlan,
  startChangePlanProviderOAuth,
  submitChangePlanProviderSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { AppRoute } from "@next/app/route-model";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  type SettingsSectionProps,
  SettingsWizardSteps,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";

const GUIDED_THINKING_LEVELS: ReadonlyArray<{ value: ChatThinkingLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "deep", label: "Deep" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const TERMINAL_CHANGE_PLAN_STATUSES = new Set<ChangePlanRecord["status"]>([
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
]);

export function GuidedModelSetup({
  workspaceId,
  onboarding,
  route,
  navigate,
  reloadOnboarding,
  setNotice,
}: {
  workspaceId: string;
  onboarding: OnboardingState;
  route: AppRoute;
  navigate: SettingsSectionProps["navigate"];
  reloadOnboarding: () => Promise<void>;
  setNotice: (notice: Notice | null) => void;
}) {
  const catalog = useProviderModelCatalog("system");
  const catalogProviders = catalog.providers;
  const loadModelsForProvider = catalog.loadModelsForProvider;
  // Keep first-run setup usable against an older or partially available
  // Gateway response. The typed contract requires settings.llm, but the UI is
  // also the recovery surface when that boundary cannot return a full payload.
  const activeProviderId = onboarding.settings?.llm?.activeProviderId ?? "";
  const activeModel = onboarding.settings?.llm?.activeModel ?? "";
  const fallbackProvider =
    catalogProviders.find((provider) => provider.providerId === activeProviderId) ??
    catalogProviders.find(
      (provider) => provider.localCostPosture === "zero_cost_local_runtime" || provider.hasApiKey,
    ) ??
    catalogProviders[0];
  const canonicalSelection = {
    providerId: activeProviderId || fallbackProvider?.providerId || "",
    model: activeModel || fallbackProvider?.defaultModel || "",
    thinkingLevel: catalog.config?.defaultThinkingLevel ?? ("standard" as ChatThinkingLevel),
  };
  const modelDraft = useSessionDraft(
    "onboarding:" + workspaceId + ":model",
    canonicalSelection,
    JSON.stringify(canonicalSelection),
    { label: "First Chat model", available: !catalog.loading },
  );
  const { providerId, model, thinkingLevel } = modelDraft.value;
  const setProviderId = (id: string) =>
    modelDraft.setValue((current) => ({
      ...current,
      providerId: id,
      model: catalogProviders.find((provider) => provider.providerId === id)?.defaultModel ?? "",
    }));
  const setModel = (model: string) => modelDraft.setValue((current) => ({ ...current, model }));
  const setThinkingLevel = (thinkingLevel: ChatThinkingLevel) =>
    modelDraft.setValue((current) => ({ ...current, thinkingLevel }));
  const busyRef = useRef(false);
  const planLoadGeneration = useRef(0);
  const [models, setModels] = useState<string[]>([]);
  const [latestPlan, setLatestPlan] = useState<ChangePlanRecord | null>(null);
  const [dialogPlan, setDialogPlan] = useState<ChangePlanRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => catalog.providers.find((provider) => provider.providerId === providerId) ?? null,
    [catalog.providers, providerId],
  );
  const providerReady = Boolean(
    selectedProvider &&
    (selectedProvider.authReadiness
      ? ["configured", "ready"].includes(selectedProvider.authReadiness.status)
      : selectedProvider.localCostPosture === "zero_cost_local_runtime" || selectedProvider.hasApiKey),
  );
  const usesChatGptOAuth = selectedProvider?.authMode === "codex-oauth";
  const defaultPlanCompleted =
    providerReady &&
    ((Boolean(activeProviderId && activeModel) &&
      activeProviderId === providerId &&
      activeModel === model &&
      thinkingLevel === (catalog.config?.defaultThinkingLevel ?? "standard")) ||
      (latestPlan?.request.kind === "installation_default_model" &&
        latestPlan.status === "completed" &&
        latestPlan.request.providerId === providerId &&
        latestPlan.request.model === model &&
        latestPlan.request.thinkingLevel === thinkingLevel));

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    const provider = catalogProviders.find((candidate) => candidate.providerId === providerId);
    setModels(provider?.models ?? (provider?.defaultModel ? [provider.defaultModel] : []));
    void loadModelsForProvider(providerId)
      .then((items) => {
        if (cancelled) return;
        const nextModels = [
          ...new Set([provider?.defaultModel, ...items].filter((item): item is string => Boolean(item))),
        ];
        setModels(nextModels);
      })
      .catch((error: unknown) => {
        if (!cancelled) setActionError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [catalogProviders, loadModelsForProvider, activeModel, activeProviderId, providerId]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++planLoadGeneration.current;
    setLatestPlan(null);
    setDialogPlan(null);
    void fetchChangePlans({ workspaceId }, { limit: 25 })
      .then(({ items }) => {
        if (cancelled) return;
        const pending = items.find(
          (plan) =>
            plan.origin.surface === "settings" &&
            ["provider_connection", "installation_default_model"].includes(plan.kind) &&
            !TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status),
        );
        if (pending && generation === planLoadGeneration.current) setLatestPlan(pending);
      })
      .catch((error) => {
        if (!cancelled) setActionError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const recordPlan = useCallback(
    async (updated: ChangePlanRecord) => {
      setLatestPlan(updated);
      if (updated.requiredAction && !TERMINAL_CHANGE_PLAN_STATUSES.has(updated.status)) {
        setDialogPlan(updated);
      } else {
        setDialogPlan(null);
      }
      if (updated.status === "completed") {
        if (updated.request.kind === "installation_default_model") {
          const saved = {
            providerId: updated.request.providerId,
            model: updated.request.model,
            thinkingLevel: updated.request.thinkingLevel ?? ("standard" as ChatThinkingLevel),
          };
          modelDraft.acceptSaved(saved, JSON.stringify(saved), saved);
        }
        setNotice({ tone: "success", message: updated.result?.summary ?? "Change applied and verified." });
        await Promise.all([catalog.reload(), reloadOnboarding()]);
      }
      return updated;
    },
    [catalog, reloadOnboarding, setNotice, modelDraft],
  );

  const runAction = useCallback(
    async (operation: () => Promise<ChangePlanRecord>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      planLoadGeneration.current += 1;
      setBusy(true);
      setActionError(null);
      try {
        await recordPlan(await operation());
      } catch (error) {
        setActionError(getErrorMessage(error));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [recordPlan],
  );

  const pendingSetupPlan = latestPlan && !TERMINAL_CHANGE_PLAN_STATUSES.has(latestPlan.status) ? latestPlan : null;
  const createProviderPlan = async () => {
    if (pendingSetupPlan) {
      setDialogPlan(pendingSetupPlan);
      return;
    }
    if (!providerId) {
      setNotice({ tone: "warning", message: "Choose a provider or local runtime first." });
      return;
    }
    await runAction(() =>
      createChangePlan({
        workspaceId,
        surface: "settings",
        request: { kind: "provider_connection", providerId },
      }),
    );
  };

  const createDefaultPlan = async () => {
    if (pendingSetupPlan) {
      setDialogPlan(pendingSetupPlan);
      return;
    }
    if (!providerId || !model) {
      setNotice({ tone: "warning", message: "Choose a verified provider and model first." });
      return;
    }
    await runAction(() =>
      createChangePlan({
        workspaceId,
        surface: "settings",
        request: { kind: "installation_default_model", providerId, model, thinkingLevel },
      }),
    );
  };

  const enterChat = async () => {
    if (!defaultPlanCompleted) {
      setNotice({ tone: "warning", message: "Confirm and verify the future-Chat model default before entering Chat." });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await completeOnboarding("operator");
      await reloadOnboarding();
      navigate({ area: "chat", theme: route.theme });
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const currentActionContext = (plan: ChangePlanRecord) => ({
    workspaceId,
    ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
    ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
  });

  return (
    <NativeCard
      id="onboarding-model"
      density="compact"
      className="mc-next-settings-panel"
      title="Connect a model"
      subtitle="Choose a provider, connect it securely, then select the model Chat should use."
      stats={[
        { label: "Connection", value: providerReady ? "Configured" : "Needs setup" },
        { label: "Model", value: model || "Choose one" },
        {
          label: "First response",
          value: onboarding.firstTask?.status === "verified" ? "Verified" : "Not yet verified",
        },
      ]}
    >
      {modelDraft.hasRemoteChanges ? (
        <p role="status">
          Saved model defaults changed. Your selection is retained; confirmation will review the current Gateway state.
        </p>
      ) : null}
      <SettingsWizardSteps
        steps={[
          {
            label: "Connect a provider",
            description: providerReady
              ? `${selectedProvider?.label ?? providerId} has a usable credential or local endpoint.`
              : "Use the secure Change Plan action to connect a provider or verify a local runtime.",
            state: providerReady ? "complete" : "active",
          },
          {
            label: "Confirm your model",
            description: defaultPlanCompleted
              ? "Your default is saved. A real Chat response verifies that the model works."
              : "This default applies only to Chats created after confirmation.",
            state: defaultPlanCompleted ? "complete" : providerReady ? "active" : "pending",
          },
          {
            label: "Start the first Chat",
            description:
              onboarding.firstTask?.status === "verified"
                ? "A completed model response is recorded in Chat."
                : "Ask your own question or choose a starter prompt in Chat.",
            state:
              onboarding.firstTask?.status === "verified" ? "complete" : defaultPlanCompleted ? "active" : "pending",
          },
        ]}
      />
      <SettingsFieldGrid>
        <SettingsField label="Provider or local runtime">
          <select
            className="mc-next-settings-input"
            value={providerId}
            disabled={busy || catalog.loading}
            onChange={(event) => {
              setProviderId(event.currentTarget.value);
            }}
          >
            {providerId && !catalog.providers.some((provider) => provider.providerId === providerId) ? (
              <option value={providerId}>{providerId} · unavailable</option>
            ) : null}
            {catalog.providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.label}
              </option>
            ))}
          </select>
          <p className="mc-next-settings-field-note">
            {usesChatGptOAuth
              ? "Use your ChatGPT account: select Connect ChatGPT, review the plan, then approve the sign-in in OpenAI."
              : (catalog.error ??
                selectedProvider?.authReadiness?.reasonCode ??
                "The Gateway will verify this connection before it can be used.")}
          </p>
        </SettingsField>
        <SettingsField label="Model">
          <select
            className="mc-next-settings-input"
            value={model}
            disabled={busy || !providerReady || models.length === 0}
            onChange={(event) => {
              setModel(event.currentTarget.value);
            }}
          >
            {model && !models.includes(model) ? <option value={model}>{model} · current selection</option> : null}
            {models.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
          <p className="mc-next-settings-field-note">
            Model availability is checked live when the Change Plan is created.
          </p>
        </SettingsField>
      </SettingsFieldGrid>
      <NativeDisclosureCard
        id="onboarding-advanced-model"
        title="Advanced model settings"
        subtitle="Adjust effort or recheck the provider connection."
      >
        <SettingsFieldGrid>
          <SettingsField label="Effort">
            <select
              className="mc-next-settings-input"
              value={thinkingLevel}
              disabled={busy || !providerReady}
              onChange={(event) => {
                setThinkingLevel(event.currentTarget.value as ChatThinkingLevel);
              }}
            >
              {GUIDED_THINKING_LEVELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mc-next-settings-field-note">
              Unsupported model-specific effort is rejected before confirmation and valid alternatives are returned.
            </p>
          </SettingsField>
        </SettingsFieldGrid>
        <NativeButton variant="secondary" disabled={busy || !providerId} onClick={() => void createProviderPlan()}>
          Verify provider connection
        </NativeButton>
      </NativeDisclosureCard>
      <SettingsButtonRow>
        <NativeButton
          variant="default"
          disabled={busy || !providerId || (providerReady && !model)}
          onClick={() =>
            void (defaultPlanCompleted ? enterChat() : providerReady ? createDefaultPlan() : createProviderPlan())
          }
        >
          {defaultPlanCompleted ? <Play size={16} /> : <Save size={16} />}
          {defaultPlanCompleted
            ? "Enter Chat"
            : providerReady
              ? "Confirm model"
              : usesChatGptOAuth
                ? "Connect ChatGPT"
                : "Connect provider"}
        </NativeButton>
      </SettingsButtonRow>
      {actionError && !dialogPlan ? <p role="alert">{actionError}</p> : null}
      {latestPlan ? (
        <ChatChangePlanCard
          plan={latestPlan}
          pending={busy}
          onReview={(plan) => {
            setActionError(null);
            setDialogPlan(plan);
          }}
          onCancel={(plan) => {
            const action = plan.requiredAction;
            if (!action) return;
            void runAction(() =>
              cancelChangePlan(plan.planId, currentActionContext(plan), {
                expectedRevision: plan.revision,
                actionNonce: action.actionNonce,
              }),
            );
          }}
        />
      ) : null}
      <ChatChangePlanActionDialog
        plan={dialogPlan}
        pending={busy}
        error={actionError}
        onClose={() => {
          if (!busy) {
            setDialogPlan(null);
            setActionError(null);
          }
        }}
        onConfirm={(plan) => {
          const action = plan.requiredAction;
          if (action?.kind !== "confirmation") {
            setActionError("This Change Plan changed. Reopen it before confirming.");
            return;
          }
          return runAction(() =>
            confirmChangePlan(plan.planId, currentActionContext(plan), {
              expectedRevision: plan.revision,
              actionNonce: action.actionNonce,
            }),
          );
        }}
        onSubmitPublicForm={(plan, values) => {
          const action = plan.requiredAction;
          if (action?.kind !== "public_form") {
            setActionError("This form changed. Reopen the Change Plan.");
            return;
          }
          return runAction(() =>
            respondToChangePlan(plan.planId, currentActionContext(plan), {
              expectedRevision: plan.revision,
              actionId: action.actionId,
              actionNonce: action.actionNonce,
              values,
            }),
          );
        }}
        onSubmitSecureInput={(plan, values) => {
          const action = plan.requiredAction;
          if (action?.kind !== "secure_input" || plan.request.kind !== "provider_connection") {
            setActionError("This secure owner action changed. Reopen the Change Plan.");
            return;
          }
          return runAction(() =>
            submitChangePlanProviderSecret(plan.planId, currentActionContext(plan), {
              expectedRevision: plan.revision,
              actionId: action.actionId,
              actionNonce: action.actionNonce,
              apiKey: values.credential ?? Object.values(values)[0] ?? "",
            }),
          );
        }}
        onContinueOAuth={async (plan) => {
          const action = plan.requiredAction;
          if (action?.kind !== "oauth" || plan.request.kind !== "provider_connection") {
            setActionError("This OAuth action changed. Reopen the Change Plan.");
            return;
          }
          await runAction(async () => {
            const context = currentActionContext(plan);
            const exact = {
              expectedRevision: plan.revision,
              actionId: action.actionId,
              actionNonce: action.actionNonce,
            };
            const flow = await startChangePlanProviderOAuth(plan.planId, context, exact);
            globalThis.open?.(flow.verificationUrl, "_blank", "noopener,noreferrer");
            let pollAfterMs = flow.pollAfterMs;
            for (;;) {
              await new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(1_000, pollAfterMs)));
              const result = await pollChangePlanProviderOAuth(plan.planId, context, {
                ...exact,
                flowId: flow.flowId,
              });
              if (result.status === "pending") {
                pollAfterMs = result.retryAfterMs ?? flow.pollAfterMs;
                continue;
              }
              if (result.status !== "connected") {
                throw new Error(result.error ?? `Provider OAuth ${result.status}. Start it again.`);
              }
              return await completeChangePlanProviderOAuth(plan.planId, context, exact);
            }
          });
        }}
        onOpenApproval={(plan) => {
          const action = plan.requiredAction;
          if (action?.kind !== "approval" || !action.approvalId) {
            setActionError("The canonical approval is not available yet.");
            return;
          }
          setDialogPlan(null);
          navigate({ area: "ops", section: "approvals", approvalId: action.approvalId, theme: route.theme });
        }}
        onReviewArtifacts={(plan) => {
          const action = plan.requiredAction;
          if (action?.kind !== "artifact_review") {
            setActionError("The artifact review changed. Reopen the Change Plan.");
            return;
          }
          return runAction(() =>
            respondToChangePlan(plan.planId, currentActionContext(plan), {
              expectedRevision: plan.revision,
              actionId: action.actionId,
              actionNonce: action.actionNonce,
              values: {},
            }),
          );
        }}
        onOpenNativePathPicker={() => {
          setActionError("Native source selection is not part of provider onboarding.");
        }}
      />
    </NativeCard>
  );
}
