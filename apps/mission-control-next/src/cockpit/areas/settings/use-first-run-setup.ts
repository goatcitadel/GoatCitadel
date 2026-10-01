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
    checking,
    notice,
    keepCurrentRule,
    finish,
    refresh,
  };
}
