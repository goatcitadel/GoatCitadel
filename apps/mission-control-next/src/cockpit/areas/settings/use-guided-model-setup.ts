import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThinkingLevel, ChangePlanRecord, OnboardingState } from "@goatcitadel/contracts";
import { cancelChangePlan, createChangePlan, fetchChangePlans } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { deriveSetupProgress } from "@goatcitadel/mission-control-shared/content/setup-progress";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  activeGuidedSetupPlans,
  clampGuidedThinkingLevel,
  GUIDED_CATALOG_LOADING_READINESS,
  GUIDED_THINKING_LEVELS,
  guidedConnectionHint,
  localRuntimeSetupGuide,
  pendingPlanForSelection,
  pickDefaultGuidedProvider,
  resolveGuidedProviderReadiness,
  submittedGuidedSelection,
  supportedGuidedThinkingLevels,
  TERMINAL_CHANGE_PLAN_STATUSES,
  withAddableBuiltinProviders,
} from "../../../features/native-routes/settings/sections/guided-model-setup-support";
import { runProviderSignIn } from "./guided-provider-sign-in";

export { TERMINAL_CHANGE_PLAN_STATUSES };

const errorText = (error: unknown) => describeApiError(error).summary;

/**
 * The guided chat-model owner's state and Gateway calls: a provider connection plan, then an installation default
 * model plan, both reviewed through Change Plans. The cockpit view renders it; the Classic view keeps its own copy.
 */
export function useGuidedModelSetup({
  workspaceId,
  onboarding,
  reloadOnboarding,
  setNotice,
  onEnterChat,
}: {
  workspaceId: string;
  onboarding: OnboardingState;
  reloadOnboarding: () => Promise<void>;
  setNotice: (message: string | null) => void;
  onEnterChat: () => void;
}) {
  const catalog = useProviderModelCatalog("system");
  // Includes built-in providers an older saved config lacks, so setup can add them.
  const catalogLoaded = !catalog.loading && !catalog.error;
  const providers = useMemo(
    () => withAddableBuiltinProviders(catalog.providers, catalogLoaded),
    [catalog.providers, catalogLoaded],
  );
  const loadModelsForProvider = catalog.loadModelsForProvider;
  // The typed contract requires settings.llm, but this is also the recovery surface for a partial Gateway payload.
  const activeProviderId = onboarding.settings?.llm?.activeProviderId ?? "";
  const activeModel = onboarding.settings?.llm?.activeModel ?? "";
  const fallbackProvider = pickDefaultGuidedProvider(providers, activeProviderId);
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
      model: providers.find((provider) => provider.providerId === id)?.defaultModel ?? "",
    }));
  const setModel = (next: string) => modelDraft.setValue((current) => ({ ...current, model: next }));
  const setThinkingLevel = (next: ChatThinkingLevel) =>
    modelDraft.setValue((current) => ({ ...current, thinkingLevel: next }));
  const busyRef = useRef(false);
  // The raw draft behind the default-model plan this wizard submitted, before effort clamping.
  const submittedDraftRef = useRef<typeof modelDraft.value | null>(null);
  const planLoadGeneration = useRef(0);
  // The running provider sign-in poll, if any; aborted on close, unmount and workspace change.
  const signInRef = useRef<AbortController | null>(null);
  // Counts workspace changes, so a settled sign-in completion can tell it outlived the visit it started in.
  const workspaceVisit = useRef(0);
  const workspaceRef = useRef(workspaceId);
  const [models, setModels] = useState<string[]>([]);
  const [latestPlan, setLatestPlan] = useState<ChangePlanRecord | null>(null);
  const [activePlans, setActivePlans] = useState<ChangePlanRecord[]>([]);
  const [dialogPlan, setDialogPlan] = useState<ChangePlanRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recheckingEndpoint, setRecheckingEndpoint] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.providerId === providerId) ?? null,
    [providers, providerId],
  );
  const supportedThinkingLevels = useMemo(
    () => supportedGuidedThinkingLevels(selectedProvider?.capabilities),
    [selectedProvider?.capabilities],
  );
  // Submit only an effort the provider accepts; the draft keeps the preference for a later reasoning provider.
  const thinkingLevel = clampGuidedThinkingLevel(requestedThinkingLevel, supportedThinkingLevels);
  const savedThinkingLevel = clampGuidedThinkingLevel(
    catalog.config?.defaultThinkingLevel ?? "standard",
    supportedThinkingLevels,
  );
  const readiness =
    !selectedProvider && catalog.loading
      ? GUIDED_CATALOG_LOADING_READINESS
      : resolveGuidedProviderReadiness(
          selectedProvider && recheckingEndpoint
            ? { ...selectedProvider, modelProbeState: "not_checked" }
            : selectedProvider,
        );
  const providerReady = readiness.state === "ready";
  // Local runtimes need no credential: the next step is re-checking the live endpoint, not a credential plan.
  const verifiesLocalEndpoint =
    selectedProvider?.localCostPosture === "zero_cost_local_runtime" && readiness.state !== "needs_setup";
  // Connection guidance only: once the provider is ready there is no Connect action to point at.
  const connectionHint = providerReady ? null : guidedConnectionHint(selectedProvider);
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
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    setModels(provider?.models ?? (provider?.defaultModel ? [provider.defaultModel] : []));
    // A provider that is not added yet has no Gateway catalog to load.
    if (provider?.addProfile) return;
    void loadModelsForProvider(providerId)
      .then((items) => {
        if (cancelled) return;
        setModels([...new Set([provider?.defaultModel, ...items].filter((item): item is string => Boolean(item)))]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setActionError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [providers, loadModelsForProvider, activeModel, activeProviderId, providerId]);

  /** Reads the workspace's active guided plans; the result applies only while `generation` is still current. */
  const readPlans = useCallback((targetWorkspaceId: string, generation: number) => {
    void fetchChangePlans({ workspaceId: targetWorkspaceId }, { limit: 25 })
      .then(({ items }) => {
        if (generation !== planLoadGeneration.current) return;
        const pending = activeGuidedSetupPlans(items);
        // Keep every active plan so Connect can resume the one for the selected provider.
        setActivePlans(pending);
        // A re-read drops a live plan it no longer lists, but keeps a finished one this visit recorded.
        setLatestPlan(
          (current) => pending[0] ?? (current && TERMINAL_CHANGE_PLAN_STATUSES.has(current.status) ? current : null),
        );
      })
      .catch((error: unknown) => {
        if (generation === planLoadGeneration.current) setActionError(errorText(error));
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
    readPlans(workspaceId, ++planLoadGeneration.current);
    return () => {
      planLoadGeneration.current += 1;
      signInRef.current?.abort();
      signInRef.current = null;
    };
  }, [workspaceId, readPlans]);

  const recordPlan = useCallback(
    async (updated: ChangePlanRecord) => {
      setLatestPlan(updated);
      setActivePlans((current) => current.map((plan) => (plan.planId === updated.planId ? updated : plan)));
      setDialogPlan(updated.requiredAction && !TERMINAL_CHANGE_PLAN_STATUSES.has(updated.status) ? updated : null);
      if (updated.status === "completed") {
        if (updated.request.kind === "installation_default_model") {
          const saved = {
            providerId: updated.request.providerId,
            model: updated.request.model,
            thinkingLevel: updated.request.thinkingLevel ?? ("standard" as ChatThinkingLevel),
          };
          const savedProvider = providers.find((provider) => provider.providerId === saved.providerId);
          const submitted = submittedGuidedSelection(
            submittedDraftRef.current,
            saved,
            supportedGuidedThinkingLevels(savedProvider?.capabilities),
          );
          modelDraft.acceptSaved(saved, JSON.stringify(saved), submitted);
        }
        setNotice(updated.result?.summary ?? "Change applied and verified.");
        await Promise.all([catalog.reload(), reloadOnboarding()]);
      } else if (updated.status === "manual_required" && updated.request.kind === "provider_connection") {
        // A failed login or connection check refreshed the Gateway's readiness; show it.
        await catalog.reload();
      }
      return updated;
    },
    [catalog, providers, reloadOnboarding, setNotice, modelDraft],
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
        if (generation === planLoadGeneration.current) setActionError(errorText(error));
      } finally {
        if (generation === planLoadGeneration.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [recordPlan],
  );

  const continueProviderSignIn = useCallback(
    async (plan: ChangePlanRecord) => {
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
    },
    [catalog, readPlans, runAction, workspaceId],
  );
  /** Stops a running sign-in poll and releases the busy state it held; a no-op when none runs. */
  const cancelProviderSignIn = useCallback(() => {
    const controller = signInRef.current;
    if (!controller) return;
    signInRef.current = null;
    controller.abort();
    // Discards the cancelled run's late result or error.
    planLoadGeneration.current += 1;
    busyRef.current = false;
    setBusy(false);
    setSigningIn(false);
  }, []);

  const livePlans = [...(latestPlan ? [latestPlan] : []), ...activePlans].filter(
    (plan) => !TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status),
  );
  const pendingConnectPlan = pendingPlanForSelection(livePlans, providerId, { kind: "provider_connection" });
  const pendingDefaultPlan = pendingPlanForSelection(livePlans, providerId, {
    kind: "installation_default_model",
    model,
    thinkingLevel,
  });
  const createPlan = async (
    pending: ChangePlanRecord | null,
    request: Parameters<typeof createChangePlan>[0]["request"],
  ) => {
    if (pending) {
      setDialogPlan(pending);
      return;
    }
    await runAction(() => createChangePlan({ workspaceId, surface: "settings", request }));
  };
  const createProviderPlan = async () => {
    if (!providerId && !pendingConnectPlan) {
      setNotice("Choose a provider or local runtime first.");
      return;
    }
    const addProfile = selectedProvider?.addProfile;
    await createPlan(pendingConnectPlan, {
      kind: "provider_connection",
      providerId,
      ...(addProfile ? { profile: addProfile } : {}),
    });
  };
  const createDefaultPlan = async () => {
    if ((!providerId || !model) && !pendingDefaultPlan) {
      setNotice("Choose a verified provider and model first.");
      return;
    }
    if (!pendingDefaultPlan) submittedDraftRef.current = modelDraft.value;
    await createPlan(pendingDefaultPlan, { kind: "installation_default_model", providerId, model, thinkingLevel });
  };
  const recheckLocalEndpoint = async () => {
    if (!providerId || recheckingEndpoint) return;
    setRecheckingEndpoint(true);
    setActionError(null);
    try {
      // Bypass the catalog cache: a failed probe is cached like a result.
      await loadModelsForProvider(providerId, { force: true });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setRecheckingEndpoint(false);
    }
  };
  const cancelPlan = (plan: ChangePlanRecord) => {
    const action = plan.requiredAction;
    if (!action) return;
    const context = {
      workspaceId,
      ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
      ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
    };
    void runAction(() =>
      cancelChangePlan(plan.planId, context, { expectedRevision: plan.revision, actionNonce: action.actionNonce }),
    );
  };
  const enterChat = () => {
    if (!defaultPlanCompleted) {
      setNotice("Confirm and verify the future-Chat model default before entering Chat.");
      return;
    }
    onEnterChat();
  };
  /** The one next action: connect, check a local endpoint, confirm the model, or move on. */
  const primary = defaultPlanCompleted
    ? { kind: "enter" as const, run: enterChat }
    : providerReady
      ? { kind: "confirm" as const, run: createDefaultPlan }
      : verifiesLocalEndpoint
        ? { kind: "check" as const, run: recheckLocalEndpoint }
        : { kind: "connect" as const, run: createProviderPlan };
  const primaryDisabled =
    busy ||
    catalog.loading ||
    !providerId ||
    (providerReady && !model) ||
    (!providerReady && verifiesLocalEndpoint && readiness.state === "checking");

  return {
    catalog,
    providers,
    /** The provider saved for future Chats, distinct from the draft selection. */
    savedProviderId: activeProviderId,
    draft: modelDraft,
    providerId,
    model,
    models,
    thinkingLevel,
    setProviderId,
    setModel,
    setThinkingLevel,
    selectedProvider,
    supportedThinkingLevels,
    effortLimited: supportedThinkingLevels.length < GUIDED_THINKING_LEVELS.length,
    localGuide: localRuntimeSetupGuide(selectedProvider, model),
    readiness,
    providerReady,
    connectionHint,
    defaultPlanCompleted,
    progress,
    busy,
    /** True while a provider sign-in polls; the review dialog stays dismissible so the user can stop it. */
    signingIn,
    actionError,
    setActionError,
    latestPlan,
    dialogPlan,
    setDialogPlan,
    runAction,
    continueProviderSignIn,
    cancelProviderSignIn,
    createProviderPlan,
    cancelPlan,
    primary,
    primaryDisabled,
  };
}

export type GuidedModelSetupControl = ReturnType<typeof useGuidedModelSetup>;
