import { useCallback, useEffect, useMemo, useState } from "react";
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
  humanizeEnumToken,
  type Notice,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  type SettingsSectionProps,
  SettingsWizardSteps,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
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
  const [providerId, setProviderId] = useState(activeProviderId);
  const [model, setModel] = useState(activeModel);
  const [thinkingLevel, setThinkingLevel] = useState<ChatThinkingLevel>(
    catalog.config?.defaultThinkingLevel ?? "standard",
  );
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
    (selectedProvider.localCostPosture === "zero_cost_local_runtime" ||
      selectedProvider.hasApiKey ||
      ["configured", "ready"].includes(selectedProvider.authReadiness?.status ?? "")),
  );
  const usesChatGptOAuth = selectedProvider?.authMode === "codex-oauth";
  const defaultPlanCompleted =
    (Boolean(activeProviderId && activeModel) && activeProviderId === providerId && activeModel === model) ||
    (latestPlan?.request.kind === "installation_default_model" && latestPlan.status === "completed");

  useEffect(() => {
    if (providerId && catalog.providers.some((provider) => provider.providerId === providerId)) return;
    const fallback =
      catalog.providers.find(
        (provider) => provider.localCostPosture === "zero_cost_local_runtime" || provider.hasApiKey,
      ) ?? catalog.providers[0];
    if (fallback) setProviderId(fallback.providerId);
  }, [catalog.providers, providerId]);

  useEffect(() => {
    if (catalog.config?.defaultThinkingLevel && !latestPlan) {
      setThinkingLevel(catalog.config.defaultThinkingLevel);
    }
  }, [catalog.config?.defaultThinkingLevel, latestPlan]);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    const provider = catalogProviders.find((candidate) => candidate.providerId === providerId);
    setModels(provider?.models ?? (provider?.defaultModel ? [provider.defaultModel] : []));
    void loadModelsForProvider(providerId).then((items) => {
      if (cancelled) return;
      const nextModels = [
        ...new Set([provider?.defaultModel, ...items].filter((item): item is string => Boolean(item))),
      ];
      setModels(nextModels);
      setModel((current) => {
        if (current && nextModels.includes(current)) return current;
        if (providerId === activeProviderId && activeModel) {
          return activeModel;
        }
        return nextModels[0] ?? "";
      });
    });
    return () => {
      cancelled = true;
    };
  }, [catalogProviders, loadModelsForProvider, activeModel, activeProviderId, providerId]);

  useEffect(() => {
    let cancelled = false;
    void fetchChangePlans({ workspaceId }, { limit: 25 })
      .then(({ items }) => {
        if (cancelled) return;
        const pending = items.find(
          (plan) =>
            plan.origin.surface === "settings" &&
            ["provider_connection", "installation_default_model"].includes(plan.kind) &&
            !TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status),
        );
        if (pending) setLatestPlan(pending);
      })
      .catch(() => undefined);
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
        setNotice({ tone: "success", message: updated.result?.summary ?? "Change applied and verified." });
        await Promise.all([catalog.reload(), reloadOnboarding()]);
      }
      return updated;
    },
    [catalog, reloadOnboarding, setNotice],
  );

  const runAction = useCallback(
    async (operation: () => Promise<ChangePlanRecord>) => {
      setBusy(true);
      setActionError(null);
      try {
        await recordPlan(await operation());
      } catch (error) {
        setActionError(getErrorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [recordPlan],
  );

  const createProviderPlan = async () => {
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
    if (!defaultPlanCompleted && (activeProviderId !== providerId || activeModel !== model)) {
      setNotice({ tone: "warning", message: "Confirm and verify the future-Chat model default before entering Chat." });
      return;
    }
    setBusy(true);
    try {
      await completeOnboarding("operator");
      navigate({ area: "chat", theme: route.theme });
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
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
        { label: "Provider", value: providerReady ? "Ready" : "Needs setup" },
        { label: "Model", value: model || "Choose one" },
        { label: "Effort", value: humanizeEnumToken(thinkingLevel) },
      ]}
    >
      <SettingsWizardSteps
        steps={[
          {
            label: "Connect and verify a provider",
            description: providerReady
              ? `${selectedProvider?.label ?? providerId} has a usable credential or local endpoint.`
              : "Use the secure Change Plan action to connect a provider or verify a local runtime.",
            state: providerReady ? "complete" : "active",
          },
          {
            label: "Choose model and effort",
            description: defaultPlanCompleted
              ? "The installation default was applied and verified."
              : "This default applies only to Chats created after confirmation.",
            state: defaultPlanCompleted ? "complete" : providerReady ? "active" : "pending",
          },
          {
            label: "Start the first Chat",
            description: "Onboarding completes only after the model default is ready.",
            state: defaultPlanCompleted || onboarding.completed ? "active" : "pending",
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
              setLatestPlan(null);
            }}
          >
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
              setLatestPlan(null);
            }}
          >
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
        <SettingsField label="Effort">
          <select
            className="mc-next-settings-input"
            value={thinkingLevel}
            disabled={busy || !providerReady}
            onChange={(event) => {
              setThinkingLevel(event.currentTarget.value as ChatThinkingLevel);
              setLatestPlan(null);
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
      <SettingsButtonRow>
        <NativeButton variant="default" disabled={busy || !providerId} onClick={() => void createProviderPlan()}>
          <Play size={16} />
          {providerReady ? "Verify provider" : usesChatGptOAuth ? "Connect ChatGPT" : "Connect provider"}
        </NativeButton>
        <NativeButton
          variant="secondary"
          disabled={busy || !providerReady || !model}
          onClick={() => void createDefaultPlan()}
        >
          <Save size={16} />
          Review model default
        </NativeButton>
        <NativeButton
          variant="secondary"
          disabled={busy || (!defaultPlanCompleted && !onboarding.completed)}
          onClick={() => void enterChat()}
        >
          Enter Chat
        </NativeButton>
      </SettingsButtonRow>
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
