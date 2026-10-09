import { useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useOnboardingCompletion } from "../../../features/native-routes/settings/use-onboarding-completion";
import {
  onboardingCompletionBinding,
  onboardingSafeMode,
} from "../../../features/native-routes/settings/onboarding-completion-state";
import { useApprovalModeControl } from "./use-approval-mode-control";
import { projectFirstRunState } from "./first-run-state";

export type FirstRunStep = "model" | "safety" | "message";
export function useFirstRunSetup(workspaceId: string | undefined) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["system", "onboarding"],
    queryFn: fetchOnboardingState,
    refetchOnWindowFocus: true,
  });
  const state = query.isError ? undefined : query.data;
  const progress = state ? projectFirstRunState(state) : null;
  const [step, setStep] = useState<FirstRunStep>("model");
  const [confirmed, setConfirmed] = useState<{ scope: string; binding: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const installation = getGatewayApiBaseUrl(),
    scope = JSON.stringify([installation, workspaceId]);
  const approval = useApprovalModeControl({ scope: `${scope}:${step}`, safeOnly: true });
  const binding = onboardingCompletionBinding(state);
  const editorIdentity = JSON.stringify([
    scope,
    step,
    binding,
    approval.draft.value,
    approval.draft.baseRevision,
    approval.locked,
  ]);
  const live = useRef({ identity: editorIdentity, generation: 0, mounted: true });
  if (live.current.identity !== editorIdentity) {
    live.current.identity = editorIdentity;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);
  const completion = useOnboardingCompletion({
    state,
    scope: editorIdentity,
    requireModel: true,
    requireSafeMode: true,
  });
  const safetyConfirmed = Boolean(
    state &&
    onboardingSafeMode(state) &&
    (state.completed || (confirmed?.scope === scope && confirmed.binding === binding)),
  );
  const approvalReady =
    approval.ready &&
    !approval.settings.isFetching &&
    !approval.locked &&
    !approval.draft.isDirty &&
    !approval.draft.hasRemoteChanges &&
    approval.current === state?.settings.toolApprovalMode &&
    approval.settings.data?.revision === state?.settings.revision;
  const canKeep = Boolean(
    state &&
    binding &&
    progress?.safeApprovalMode &&
    approvalReady &&
    !checking &&
    !completion.locked &&
    !query.isFetching,
  );
  const canFinish = Boolean(
    state &&
    !state.completed &&
    progress?.modelReady &&
    safetyConfirmed &&
    approvalReady &&
    completion.ready &&
    !completion.locked &&
    !query.isFetching &&
    !checking,
  );
  const finishPrerequisite = state?.completed ? "Setup is already recorded. Open Chat to send a message."
    : completion.attempt?.phase === "unknown" ? "Setup completion is uncertain. Refresh checks to inspect the recorded marker."
    : completion.locked ? "Wait for the Gateway to confirm setup completion."
    : query.isFetching || checking ? "Wait for the current setup checks to finish." // refetch-guard: allow Prerequisite text changes during checks; the current setup record remains visible.
    : !progress?.modelReady ? "Connect a provider and confirm a ready default model before finishing."
    : approval.locked ? "Resolve the pending or uncertain approval-rule save before finishing."
    : approval.draft.isDirty || approval.draft.hasRemoteChanges ? "Save or reconcile the approval-rule draft, then refresh checks and review the current rule."
    : !approvalReady ? "Refresh checks to confirm the current approval rule and settings revision."
    : !progress.safeApprovalMode ? "Choose and save an approval rule that keeps prompts, then refresh checks and review the current rule."
    : !safetyConfirmed ? "Review the current approval rule in Step 2 and choose Keep current rule before finishing."
    : !completion.ready ? "Refresh checks and review the current model and approval rule before finishing."
    : "Ready to finish setup and open Chat. A completed Chat answer verifies the model separately.";

  async function keepCurrentRule() {
    if (!canKeep || !binding || approval.change.isPending()) return;
    const generation = live.current.generation;
    const current = () =>
      live.current.mounted &&
      live.current.generation === generation &&
      live.current.identity === editorIdentity &&
      getGatewayApiBaseUrl() === installation;
    setChecking(true);
    setNotice(null);
    try {
      const fresh = await fetchOnboardingState();
      if (!current() || approval.change.isPending()) return;
      const freshBinding = onboardingCompletionBinding(fresh);
      client.setQueryData(["system", "onboarding"], fresh);
      if (freshBinding !== binding || !onboardingSafeMode(fresh)) {
        setConfirmed(null);
        setNotice("Setup changed. Review the current model and approval rule again.");
        return;
      }
      setConfirmed({ scope, binding });
      setNotice("Current approval rule reviewed. Finish setup, then send your first test message in Chat.");
    } catch (error) {
      if (current()) setNotice(describeApiError(error).summary);
    } finally {
      if (live.current.mounted) setChecking(false);
    }
  }
  async function continueModel() {
    if (!progress?.modelReady || query.isFetching || checking || completion.locked || approval.locked) return;
    const generation = live.current.generation;
    setChecking(true);
    try {
      const fresh = await fetchOnboardingState();
      if (!live.current.mounted || live.current.generation !== generation || getGatewayApiBaseUrl() !== installation) return;
      client.setQueryData(["system", "onboarding"], fresh);
      if (projectFirstRunState(fresh).modelReady) setStep("safety");
      else setNotice("Model readiness changed. Connect and confirm the current default before continuing.");
    } catch (error) {
      if (live.current.mounted && live.current.generation === generation) setNotice(describeApiError(error).summary);
    } finally {
      if (live.current.mounted) setChecking(false);
    }
  }
  async function finish() {
    if (!canFinish || approval.change.isPending()) return false;
    const result = await completion.complete();
    if (!result) return false;
    client.setQueryData(["system", "onboarding"], result);
    return true;
  }
  async function refresh() {
    live.current.generation += 1;
    await Promise.all([query.refetch(), approval.settings.refetch()]);
  }
  return {
    query,
    state,
    progress,
    step,
    setStep,
    approval,
    completion,
    safetyConfirmed,
    canKeep,
    canFinish,
    finishPrerequisite,
    checking,
    notice,
    keepCurrentRule,
    continueModel,
    finish,
    refresh,
  };
}
