import { useSessionDraft } from "../../library/session-drafts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Play, PlugZap } from "lucide-react";
import type { ChatThinkingLevel, ChangePlanRecord, OnboardingState } from "@goatcitadel/contracts";
import {
  cancelChangePlan,
  confirmChangePlan,
  createChangePlan,
  fetchChangePlans,
  respondToChangePlan,
  submitChangePlanProviderSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { deriveSetupProgress } from "@goatcitadel/mission-control-shared/content/setup-progress";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { AppRoute } from "@next/app/route-model";
import { runProviderSignIn, SIGN_IN_WAITING_NOTE } from "../../../../cockpit/areas/settings/guided-provider-sign-in";
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
import { useOnboardingCompletion } from "../use-onboarding-completion";
import {
  activeGuidedSetupPlans,
  clampGuidedThinkingLevel,
  GUIDED_CATALOG_LOADING_READINESS,
  GUIDED_THINKING_LEVELS,
  guidedConnectionHint,
  localRuntimeSetupGuide,
  mergePlansByRevision,
  pendingPlanForSelection,
  pickDefaultGuidedProvider,
  resolveGuidedProviderReadiness,
  submittedGuidedSelection,
  supportedGuidedThinkingLevels,
  TERMINAL_CHANGE_PLAN_STATUSES,
  withAddableBuiltinProviders,
  withHeldPlan,
} from "./guided-model-setup-support";

export function GuidedModelSetup({
  workspaceId,
  onboarding,
  route,
  navigate,
  reloadOnboarding,
  setNotice,
  excludeLlamaCpp = false,
  onEnterChat,
  enterChatLabel = "Enter Chat",
  renderApprovalAction,
}: {
  workspaceId: string;
  onboarding: OnboardingState;
  route: AppRoute;
  navigate: SettingsSectionProps["navigate"];
  reloadOnboarding: () => Promise<void>;
  setNotice: (notice: Notice | null) => void;
  excludeLlamaCpp?: boolean;
  /** Guided hosts can keep their own completion gate before entering Chat. */
  onEnterChat?: () => void;
  /** Button text once the default is confirmed. A host whose `onEnterChat` does not open Chat should say so. */
  enterChatLabel?: string;
  renderApprovalAction?: (
    plan: ChangePlanRecord,
    pending: boolean,
    selection: { providerId: string; model: string; thinkingLevel: ChatThinkingLevel },
  ) => ReactNode;
}) {
  const catalog = useProviderModelCatalog("system");
  const completion = useOnboardingCompletion({ state: onboarding, scope: workspaceId, requireModel: true });
  const catalogLoaded = !catalog.loading && !catalog.error;
  const catalogProviders = useMemo(
    () =>
      // Includes built-in providers an older saved config lacks, so setup can add them.
      withAddableBuiltinProviders(
        excludeLlamaCpp
          ? catalog.providers.filter((provider) => provider.providerId !== "llamacpp")
          : catalog.providers,
        catalogLoaded,
      ),
    [catalog.providers, catalogLoaded, excludeLlamaCpp],
  );
  const loadModelsForProvider = catalog.loadModelsForProvider;
  // Keep first-run setup usable against an older or partially available
  // Gateway response. The typed contract requires settings.llm, but the UI is
  // also the recovery surface when that boundary cannot return a full payload.
  const activeProviderId =
    excludeLlamaCpp && onboarding.settings?.llm?.activeProviderId === "llamacpp"
      ? ""
      : (onboarding.settings?.llm?.activeProviderId ?? "");
  const activeModel =
    excludeLlamaCpp && onboarding.settings?.llm?.activeProviderId === "llamacpp"
      ? ""
      : (onboarding.settings?.llm?.activeModel ?? "");
  const fallbackProvider = pickDefaultGuidedProvider(catalogProviders, activeProviderId);
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
  const { providerId, model, thinkingLevel: requestedThinkingLevel } = modelDraft.value;
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
  // The raw draft behind the default-model plan this wizard submitted, before effort clamping.
  const submittedDraftRef = useRef<typeof modelDraft.value | null>(null);
  const planLoadGeneration = useRef(0);
  // The newest record of each plan this visit recorded from an action, so a late plan read cannot step one back.
  const recordedPlans = useRef<readonly ChangePlanRecord[]>([]);
  // The running provider sign-in poll, if any; aborted on close, unmount and workspace change.
  const signInRef = useRef<AbortController | null>(null);
  // Counts workspace changes, so a settled sign-in completion can tell it outlived the visit it started in.
  const workspaceVisit = useRef(0);
  const workspaceRef = useRef(workspaceId);
  const [signingIn, setSigningIn] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [latestPlan, setLatestPlan] = useState<ChangePlanRecord | null>(null);
  const [activePlans, setActivePlans] = useState<ChangePlanRecord[]>([]);
  const [dialogPlan, setDialogPlan] = useState<ChangePlanRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => catalogProviders.find((provider) => provider.providerId === providerId) ?? null,
    [catalogProviders, providerId],
  );
  const supportedThinkingLevels = useMemo(
    () => supportedGuidedThinkingLevels(selectedProvider?.capabilities),
    [selectedProvider?.capabilities],
  );
  // Submit only an effort the selected provider accepts; the draft keeps the
  // operator's preference so switching back to a reasoning provider restores it.
  const thinkingLevel = clampGuidedThinkingLevel(requestedThinkingLevel, supportedThinkingLevels);
  const savedThinkingLevel = clampGuidedThinkingLevel(
    catalog.config?.defaultThinkingLevel ?? "standard",
    supportedThinkingLevels,
  );
  const effortLimited = supportedThinkingLevels.length < GUIDED_THINKING_LEVELS.length;
  const localGuide = localRuntimeSetupGuide(selectedProvider, model);
  const [recheckingEndpoint, setRecheckingEndpoint] = useState(false);
  const providerReadiness =
    !selectedProvider && catalog.loading
      ? GUIDED_CATALOG_LOADING_READINESS
      : resolveGuidedProviderReadiness(
          selectedProvider && recheckingEndpoint
            ? { ...selectedProvider, modelProbeState: "not_checked" }
            : selectedProvider,
        );
  const providerReady = providerReadiness.state === "ready";
  // Local runtimes need no credential: their readiness comes from the live
  // endpoint probe, so the next step is re-checking it, not a credential plan.
  const verifiesLocalEndpoint =
    selectedProvider?.localCostPosture === "zero_cost_local_runtime" && providerReadiness.state !== "needs_setup";
  // Connection guidance only: once the provider is ready there is no Connect action to point at.
  const connectionHint = providerReady ? null : guidedConnectionHint(selectedProvider);
  // Offer the better-supported provider as a one-click switch, only when the list has it.
  const alternative = catalogProviders.some(
    (provider) => provider.providerId === connectionHint?.alternative?.providerId,
  )
    ? connectionHint?.alternative
    : undefined;
  // Shown beside the provider hint, never replaced by it.
  // The local CLI's login state is already described in plain words by its readiness step.
  const connectionDiagnostic =
    catalog.error ??
    (selectedProvider?.authMode === "claude-code-cli-login"
      ? undefined
      : selectedProvider?.authReadiness?.reasonCode) ??
    null;
  const defaultPlanCompleted =
    providerReady &&
    ((Boolean(activeProviderId && activeModel) &&
      activeProviderId === providerId &&
      activeModel === model &&
      thinkingLevel === savedThinkingLevel) ||
      (latestPlan?.request.kind === "installation_default_model" &&
        latestPlan.status === "completed" &&
        latestPlan.request.providerId === providerId &&
        latestPlan.request.model === model &&
        latestPlan.request.thinkingLevel === thinkingLevel));
  const progress = deriveSetupProgress({
    providerReady,
    defaultPlanCompleted,
    firstResponseVerified: onboarding.firstTask?.status === "verified",
  });

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    const provider = catalogProviders.find((candidate) => candidate.providerId === providerId);
    setModels(provider?.models ?? (provider?.defaultModel ? [provider.defaultModel] : []));
    // A provider that is not added yet has no Gateway catalog to load.
    if (provider?.addProfile) return;
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

  /** Reads the workspace's active guided plans; the result applies only while `generation` is still current. */
  const readPlans = useCallback((targetWorkspaceId: string, generation: number) => {
    void fetchChangePlans({ workspaceId: targetWorkspaceId }, { limit: 25 })
      .then(({ items }) => {
        if (generation !== planLoadGeneration.current) return;
        // A read that snapshotted a plan before this visit recorded a newer revision keeps the newer record.
        const pending = activeGuidedSetupPlans(mergePlansByRevision(items, recordedPlans.current));
        // Keep every active plan so Connect can resume the one for the selected provider.
        setActivePlans(pending);
        // A re-read drops a live plan it no longer lists, but keeps a finished one this visit recorded.
        setLatestPlan(
          (current) => pending[0] ?? (current && TERMINAL_CHANGE_PLAN_STATUSES.has(current.status) ? current : null),
        );
      })
      .catch((error) => {
        if (generation === planLoadGeneration.current) setActionError(getErrorMessage(error));
      });
  }, []);

  useEffect(() => {
    workspaceVisit.current += 1;
    workspaceRef.current = workspaceId;
    busyRef.current = false;
    setBusy(false);
    setSigningIn(false);
    setActionError(null);
    setLatestPlan(null);
    setActivePlans([]);
    setDialogPlan(null);
    recordedPlans.current = [];
    readPlans(workspaceId, ++planLoadGeneration.current);
    return () => {
      planLoadGeneration.current += 1;
      signInRef.current?.abort();
      signInRef.current = null;
    };
  }, [workspaceId, readPlans]);

  const recordPlan = useCallback(
    async (updated: ChangePlanRecord) => {
      recordedPlans.current = withHeldPlan(recordedPlans.current, updated);
      setLatestPlan(updated);
      setActivePlans((current) => current.map((plan) => (plan.planId === updated.planId ? updated : plan)));
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
          const savedProvider = catalog.providers.find((provider) => provider.providerId === saved.providerId);
          const submitted = submittedGuidedSelection(
            submittedDraftRef.current,
            saved,
            supportedGuidedThinkingLevels(savedProvider?.capabilities),
          );
          modelDraft.acceptSaved(saved, JSON.stringify(saved), submitted);
        }
        setNotice({ tone: "success", message: updated.result?.summary ?? "Change applied and verified." });
        await Promise.all([catalog.reload(), reloadOnboarding()]);
      } else if (updated.status === "manual_required" && updated.request.kind === "provider_connection") {
        // A failed login or connection check refreshed the Gateway's readiness; show it.
        await catalog.reload();
      }
      return updated;
    },
    [catalog, reloadOnboarding, setNotice, modelDraft],
  );

  const runAction = useCallback(
    async (operation: () => Promise<ChangePlanRecord>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const generation = ++planLoadGeneration.current;
      setBusy(true);
      setActionError(null);
      try {
        const updated = await operation();
        if (generation !== planLoadGeneration.current) return;
        await recordPlan(updated);
      } catch (error) {
        if (generation === planLoadGeneration.current) setActionError(getErrorMessage(error));
      } finally {
        if (generation === planLoadGeneration.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [recordPlan],
  );

  const continueProviderSignIn = async (plan: ChangePlanRecord) => {
    if (plan.requiredAction?.kind !== "oauth" || plan.request.kind !== "provider_connection") {
      setActionError("This sign-in action changed. Reopen the setup request.");
      return;
    }
    const visit = workspaceVisit.current;
    let completing = false;
    await runAction(async () => {
      const controller = new AbortController();
      signInRef.current = controller;
      setSigningIn(true);
      try {
        return await runProviderSignIn(plan, workspaceId, controller.signal, {
          // Past this point the Gateway consumes the sign-in, so closing the dialog must no longer cancel the run.
          onCompleting: () => {
            completing = true;
            if (signInRef.current === controller) signInRef.current = null;
            setSigningIn(false);
          },
        });
      } finally {
        if (signInRef.current === controller) {
          signInRef.current = null;
          setSigningIn(false);
        }
        // The workspace changed while completion ran, so runAction discards the record. A plan read made
        // meanwhile may hold the old revision: re-read it if the operator is back in this workspace (a later
        // visit reads it fresh), and refresh the install-wide provider readiness either way.
        if (completing && workspaceVisit.current !== visit) {
          if (workspaceRef.current === workspaceId) {
            // An action running in this visit keeps its generation; it already invalidated older reads.
            readPlans(workspaceId, busyRef.current ? planLoadGeneration.current : ++planLoadGeneration.current);
          }
          void catalog.reload();
        }
      }
    });
  };
  /** Stops a running sign-in poll and releases the busy state it held; a no-op when none runs. */
  const cancelProviderSignIn = () => {
    const controller = signInRef.current;
    if (!controller) return;
    signInRef.current = null;
    controller.abort();
    // Discards the cancelled run's late result or error.
    planLoadGeneration.current += 1;
    busyRef.current = false;
    setBusy(false);
    setSigningIn(false);
  };

  const livePlans = [...(latestPlan ? [latestPlan] : []), ...activePlans].filter(
    (plan) => !TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status),
  );
  const pendingConnectPlan = pendingPlanForSelection(livePlans, providerId, { kind: "provider_connection" });
  const pendingDefaultPlan = pendingPlanForSelection(livePlans, providerId, {
    kind: "installation_default_model",
    model,
    thinkingLevel,
  });
  const createProviderPlan = async () => {
    if (pendingConnectPlan) {
      setDialogPlan(pendingConnectPlan);
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
        request: {
          kind: "provider_connection",
          providerId,
          ...(selectedProvider?.addProfile ? { profile: selectedProvider.addProfile } : {}),
        },
      }),
    );
  };

  const recheckLocalEndpoint = async () => {
    if (!providerId || recheckingEndpoint) return;
    setRecheckingEndpoint(true);
    setActionError(null);
    try {
      // Bypass the catalog cache: a failed probe is cached like a result.
      await loadModelsForProvider(providerId, { force: true });
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setRecheckingEndpoint(false);
    }
  };

  const createDefaultPlan = async () => {
    if (pendingDefaultPlan) {
      setDialogPlan(pendingDefaultPlan);
      return;
    }
    if (!providerId || !model) {
      setNotice({ tone: "warning", message: "Choose a verified provider and model first." });
      return;
    }
    submittedDraftRef.current = modelDraft.value;
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
    if (onEnterChat) {
      onEnterChat();
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = ++planLoadGeneration.current;
    setBusy(true);
    try {
      if (!(await completion.complete())) return;
      if (generation !== planLoadGeneration.current) return;
      await reloadOnboarding();
      if (generation !== planLoadGeneration.current) return;
      navigate({ area: "chat", theme: route.theme });
    } catch (error) {
      if (generation === planLoadGeneration.current) setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      if (generation === planLoadGeneration.current) {
        busyRef.current = false;
        setBusy(false);
      }
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
        { label: "Connection", value: providerReadiness.label },
        // A template default is only a suggestion until the provider is ready.
        { label: "Model", value: !model ? "Choose one" : providerReady ? model : `Suggested: ${model}` },
        { label: "First response", value: progress.firstResponseLabel },
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
            description: providerReadiness.description,
            state: progress.steps[0],
          },
          {
            label: "Confirm your model",
            description: defaultPlanCompleted
              ? "Your default is saved. A real Chat response verifies that the model works."
              : "This default applies only to Chats created after confirmation.",
            state: progress.steps[1],
          },
          {
            label: "Start the first Chat",
            description: progress.needsRecheck
              ? "Your first response was verified earlier. Check the connection to continue."
              : progress.steps[2] === "complete"
                ? "A completed model response is recorded in Chat."
                : "Ask your own question or choose a starter prompt in Chat.",
            state: progress.steps[2],
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
            {!providerId ? (
              <option value="" disabled>
                Choose a provider or local runtime
              </option>
            ) : null}
            {providerId && !catalogProviders.some((provider) => provider.providerId === providerId) ? (
              <option value={providerId}>
                {catalog.loading ? "Loading providers…" : `${providerId} · unavailable`}
              </option>
            ) : null}
            {catalogProviders.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.label}
              </option>
            ))}
          </select>
          {connectionHint ? <p className="mc-next-settings-field-note">{connectionHint.note}</p> : null}
          {connectionDiagnostic || !connectionHint ? (
            <p className="mc-next-settings-field-note">
              {connectionDiagnostic ?? "The Gateway will verify this connection before it can be used."}
            </p>
          ) : null}
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
            GoatCitadel checks that the model is available when you confirm it.
          </p>
        </SettingsField>
      </SettingsFieldGrid>
      {localGuide && !defaultPlanCompleted ? (
        <section aria-label={localGuide.title}>
          <p>
            <strong>{localGuide.title}</strong>
          </p>
          <ol className="mc-next-settings-field-note">
            {localGuide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {localGuide.command ? (
            <div className="mc-next-settings-code-block">
              <code>{localGuide.command}</code>
            </div>
          ) : null}
        </section>
      ) : null}
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
              {GUIDED_THINKING_LEVELS.filter((option) => supportedThinkingLevels.includes(option.value)).map(
                (option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ),
              )}
            </select>
            <p className="mc-next-settings-field-note">
              {supportedThinkingLevels.length === 1
                ? `${selectedProvider?.label ?? "This provider"} does not report reasoning effort, so effort stays Off.`
                : effortLimited
                  ? `Showing only the effort levels ${selectedProvider?.label ?? "this provider"} supports.`
                  : "Unsupported model-specific effort is rejected before confirmation and valid alternatives are returned."}
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
          disabled={
            busy ||
            catalog.loading ||
            (defaultPlanCompleted && !onEnterChat && (completion.locked || !completion.ready)) ||
            !providerId ||
            (providerReady && !model) ||
            (!providerReady && verifiesLocalEndpoint && providerReadiness.state === "checking")
          }
          onClick={() =>
            void (defaultPlanCompleted
              ? enterChat()
              : providerReady
                ? createDefaultPlan()
                : verifiesLocalEndpoint
                  ? recheckLocalEndpoint()
                  : createProviderPlan())
          }
        >
          {defaultPlanCompleted ? <Play size={16} /> : <PlugZap size={16} />}
          {defaultPlanCompleted
            ? enterChatLabel
            : providerReady
              ? "Confirm model"
              : verifiesLocalEndpoint
                ? providerReadiness.state === "checking"
                  ? "Checking connection…"
                  : "Check connection"
                : (connectionHint?.connectLabel ?? "Connect provider")}
        </NativeButton>
        {alternative ? (
          <NativeButton variant="secondary" disabled={busy} onClick={() => setProviderId(alternative.providerId)}>
            {alternative.label}
          </NativeButton>
        ) : null}
      </SettingsButtonRow>
      {actionError && !dialogPlan ? <p role="alert">{actionError}</p> : null}
      {completion.notice || completion.attempt ? (
        <p role="status">{completion.attempt?.message ?? completion.notice}</p>
      ) : null}
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
        // A polling sign-in waits on the user's browser, so the dialog stays closable to stop it.
        pending={busy && !signingIn}
        waiting={signingIn}
        contextNote={signingIn ? SIGN_IN_WAITING_NOTE : undefined}
        error={actionError}
        renderApprovalAction={
          renderApprovalAction
            ? (plan, pending) => renderApprovalAction(plan, pending, { providerId, model, thinkingLevel })
            : undefined
        }
        onClose={() => {
          cancelProviderSignIn();
          if (busy && !signingIn) return;
          setDialogPlan(null);
          setActionError(null);
        }}
        onConfirm={(plan) => {
          const action = plan.requiredAction;
          if (action?.kind !== "confirmation") {
            setActionError("The setup request changed. Reopen it before confirming.");
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
            setActionError("This form changed. Reopen the setup request.");
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
            setActionError("This secure action changed. Reopen the setup request.");
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
        onContinueOAuth={continueProviderSignIn}
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
            setActionError("The artifact review changed. Reopen the setup request.");
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
