import { useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolApprovalMode } from "@goatcitadel/contracts";
import {
  fetchSettings,
  patchSettings,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useSettingsChange } from "../../../features/native-routes/settings/use-settings-change";
import {
  APPROVAL_MODE_DRAFT_KEY,
  hasApprovalSettings,
  isApprovalMode,
  isApprovalRevisionConflict,
  matchesApprovalModePlan,
  retainApprovalModeUncertainty,
  useApprovalModeUncertainty,
} from "./approval-mode-state";

export interface ApprovalReview {
  mode: ToolApprovalMode;
  revision: number;
  current: ToolApprovalMode;
  profile: RuntimeSettingsResponse["deploymentProfile"];
  generation: number;
}
export function useApprovalModeControl({ scope = "installation", safeOnly = false } = {}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["system", "settings-approval-mode"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const ready = !settings.isError && hasApprovalSettings(settings.data);
  const current = isApprovalMode(settings.data?.toolApprovalMode) ? settings.data.toolApprovalMode : "approve_all";
  const draft = useSessionDraft(APPROVAL_MODE_DRAFT_KEY, current, settings.data?.revision, {
    label: "Tool approval rule",
    available: ready,
    onSave: () => requestSave(),
  });
  const change = useSettingsChange<ToolApprovalMode>({
    key: draft.key,
    operation: "tool_approval_mode",
    matchesPlan: matchesApprovalModePlan,
    matches: (saved, submitted) => saved.toolApprovalMode === submitted,
    acceptSaved: draft.acceptSaved,
    reload: () => settings.refetch(),
  });
  const uncertain = useApprovalModeUncertainty();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const restricted = safeOnly || settings.data?.deploymentProfile === "remote_hardened";
  const installation = getGatewayApiBaseUrl();
  const identity = JSON.stringify([
    installation,
    scope,
    safeOnly,
    draft.value,
    draft.baseRevision,
    current,
    settings.data?.revision,
    settings.data?.deploymentProfile,
  ]);
  const live = useRef({ identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
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
  const isCurrent = (generation: number) =>
    live.current.mounted &&
    live.current.generation === generation &&
    live.current.identity === identity &&
    getGatewayApiBaseUrl() === installation;
  const locked = busy || change.hasPending || Boolean(uncertain);
  const canSave =
    ready &&
    !settings.isFetching &&
    !locked &&
    draft.isDirty &&
    !draft.hasRemoteChanges &&
    !(draft.value === "bypass" && restricted);

  async function requestSave(): Promise<boolean> {
    if (!canSave || !settings.data) return false;
    const intent: ApprovalReview = {
      mode: draft.value,
      revision: Number(draft.baseRevision),
      current,
      profile: settings.data.deploymentProfile,
      generation: live.current.generation,
    };
    if (intent.mode === "bypass") {
      setNotice(null);
      setReview(intent);
      return false;
    }
    return save(intent);
  }
  async function save(intent: ApprovalReview): Promise<boolean> {
    if (
      !canSave ||
      !settings.data ||
      !isCurrent(intent.generation) ||
      draft.value !== intent.mode ||
      draft.baseRevision !== intent.revision ||
      current !== intent.current ||
      settings.data.deploymentProfile !== intent.profile ||
      !change.beginSave()
    )
      return false;
    setBusy(true);
    setNotice(null);
    setReview(null);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (!isCurrent(intent.generation)) return false;
      const cached = queryClient.getQueryData<RuntimeSettingsResponse>(["system", "settings-approval-mode"]);
      if (
        !hasApprovalSettings(cached) ||
        cached.revision !== intent.revision ||
        cached.toolApprovalMode !== intent.current ||
        cached.deploymentProfile !== intent.profile ||
        !hasApprovalSettings(latest) ||
        latest.revision !== intent.revision ||
        latest.toolApprovalMode !== intent.current ||
        latest.deploymentProfile !== intent.profile
      ) {
        setNotice(
          "Approval settings changed. Review the current rule and revision before applying your preserved draft.",
        );
        await settings.refetch();
        return false;
      }
      mutationAttempted = true;
      const response = await patchSettings({ expectedRevision: intent.revision, toolApprovalMode: intent.mode });
      if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway installation changed during the save.");
      // Retain the dispatched origin result even after its editor unmounts.
      const saved = change.receive(response, intent.mode, intent.revision);
      if (!isCurrent(intent.generation)) return false;
      setNotice(
        saved
          ? "Tool approval rule saved and confirmed by the Gateway."
          : "Change submitted. The Gateway must confirm settlement before this draft is saved.",
      );
      await settings.refetch();
      return saved && live.current.mounted && getGatewayApiBaseUrl() === installation;
    } catch (error) {
      if (isApprovalRevisionConflict(error, intent.revision)) {
        if (!isCurrent(intent.generation)) return false;
        setNotice("The Gateway rejected the stale settings revision. Your draft is preserved for review.");
        await settings.refetch();
      } else if (mutationAttempted) {
        retainApprovalModeUncertainty(
          "Save outcome is uncertain. Further saves are locked in this app session; inspect Settings activity before continuing.",
        );
      } else if (isCurrent(intent.generation)) {
        setNotice(`Could not confirm current approval settings. ${describeApiError(error).summary}`);
      }
      return false;
    } finally {
      change.endSave();
      if (live.current.mounted) setBusy(false);
    }
  }
  const reviewCurrent = Boolean(
    review &&
    isCurrent(review.generation) &&
    canSave &&
    review.mode === draft.value &&
    review.revision === draft.baseRevision &&
    review.current === current &&
    review.profile === settings.data?.deploymentProfile,
  );
  return {
    settings,
    ready,
    current,
    draft,
    change,
    uncertain,
    busy,
    review,
    setReview,
    notice,
    restricted,
    locked,
    canSave,
    reviewCurrent,
    requestSave,
    confirm: () => (review ? save(review) : Promise.resolve(false)),
  };
}
