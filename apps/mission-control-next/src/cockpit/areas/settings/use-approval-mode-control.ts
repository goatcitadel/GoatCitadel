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
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  classifySettingsSaveFailure,
  findActiveSettingsChange,
  describeWaitingChange,
  findWaitingSettingsChange,
  sendTrackedSettingsSave,
  settingsSaveFinished,
  waitingNoticeFor,
  type WaitingSettingsNotice,
} from "../../../features/native-routes/settings/settings-save-outcome";
import type { TrackedAttempt } from "../../../features/native-routes/settings/mutation-attempt-tracking";
import { useSettingsChange } from "../../../features/native-routes/settings/use-settings-change";
import {
  APPROVAL_MODE_DRAFT_KEY,
  clearApprovalModeUncertainty,
  currentApprovalModeUncertainty,
  hasApprovalSettings,
  isApprovalMode,
  isApprovalRevisionConflict,
  matchesApprovalModePlan,
  retainApprovalModeUncertainty,
  settleApprovalModeUncertainty,
  useApprovalModeUncertainty,
  type ApprovalModeUncertainty,
} from "./approval-mode-state";

const CHECKING_MESSAGE = "Checking whether your approval rule was saved…";
const UNCONFIRMED_MESSAGE =
  "GoatCitadel didn't answer, so this save isn't confirmed yet. Saving stays paused until the saved rule can be checked.";

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
  const installation = getGatewayApiBaseUrl();
  // Each Gateway keeps its own record of an unconfirmed save; another installation's record locks nothing here.
  const uncertain = useApprovalModeUncertainty(installation);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<WaitingSettingsNotice | null>(null);
  const restricted = safeOnly || settings.data?.deploymentProfile === "remote_hardened";
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
    !waiting &&
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
    let transport: TrackedAttempt | undefined;
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
          "Approval settings changed. Your draft started from an older version and is kept. Review the current rule first.",
        );
        await settings.refetch();
        return false;
      }
      mutationAttempted = true;
      const response = await sendTrackedSettingsSave(
        () => patchSettings({ expectedRevision: intent.revision, toolApprovalMode: intent.mode }),
        (tracked) => {
          transport = tracked;
        },
      );
      if (getGatewayApiBaseUrl() !== installation)
        throw new Error("You switched to a different GoatCitadel installation, so the save could not be confirmed.");
      // Retain the dispatched origin result even after its editor unmounts.
      const saved = change.receive(response, intent.mode, intent.revision);
      if (!isCurrent(intent.generation)) return false;
      setNotice(
        saved
          ? "Tool approval rule saved and confirmed by GoatCitadel."
          : "Change submitted. GoatCitadel must confirm it before this draft is saved.",
      );
      await settings.refetch();
      return saved && live.current.mounted && getGatewayApiBaseUrl() === installation;
    } catch (error) {
      if (isApprovalRevisionConflict(error, intent.revision)) {
        if (!isCurrent(intent.generation)) return false;
        setNotice("Not saved: the settings changed since your draft started. Your draft is kept for review.");
        await settings.refetch();
      } else if (mutationAttempted) {
        const failure = classifySettingsSaveFailure(error);
        if (failure.kind === "waiting") {
          // An earlier change to this rule is still open: lead to its approval and keep the draft.
          await settings.refetch();
          if (isCurrent(intent.generation)) await followWaiting(failure.planId);
        } else if (failure.kind === "conflict") {
          if (isCurrent(intent.generation)) {
            setNotice("Not saved: the settings changed since your draft started. Your draft is kept for review.");
            await settings.refetch();
          }
        } else if (failure.kind === "refused") {
          if (isCurrent(intent.generation)) setNotice(`Not saved. ${failure.reason}`);
        } else {
          const record: ApprovalModeUncertainty = {
            message: CHECKING_MESSAGE,
            submitted: intent.mode,
            baseRevision: intent.revision,
            previous: current,
            installation,
            ...(transport ? { transport } : {}),
            checking: true,
          };
          retainApprovalModeUncertainty(record);
          void reconcileRecord(record);
        }
      } else if (isCurrent(intent.generation)) {
        setNotice(`Could not confirm current approval settings. ${describeApiError(error).summary}`);
      }
      return false;
    } finally {
      change.endSave();
      if (live.current.mounted) setBusy(false);
    }
  }
  /**
   * After a save whose answer was lost: reads the saved rule and the open changes again. The lock lifts once either
   * says what happened, and holds only while neither can be read; a failed read is never reported as "not saved".
   */
  async function reconcileRecord(start: ApprovalModeUncertainty): Promise<void> {
    try {
      await settleRecord(start);
    } catch {
      // Whatever went wrong, the write is still unconfirmed: keep saving paused rather than guess.
      retainApprovalModeUncertainty({ ...start, message: UNCONFIRMED_MESSAGE, checking: false });
    }
  }
  /**
   * First asks the Gateway whether that very request has finished: a request still running can apply after any read,
   * so the rule is called "not saved" only once it has (without an attempt identity it never is). Then reads the open
   * changes first and the saved rule second, so a change that finishes in between shows up as the saved rule. All
   * reads are made after the write, never joined to an older one. A failed read keeps the lock.
   */
  async function settleRecord(start: ApprovalModeUncertainty): Promise<void> {
    const record = { ...start, message: CHECKING_MESSAGE, checking: true };
    retainApprovalModeUncertainty(record);
    const keepLocked = () =>
      retainApprovalModeUncertainty({ ...record, message: UNCONFIRMED_MESSAGE, checking: false });
    // Another Gateway cannot say whether this one applied the write.
    if (getGatewayApiBaseUrl() !== record.installation) return keepLocked();
    const finished = record.transport ? await settingsSaveFinished(record.transport) : false;
    if (record.transport && !finished) return keepLocked();
    const active = await findActiveSettingsChange((plan) => matchesApprovalModePlan(plan, record.submitted));
    if (active === "unreadable") return keepLocked();
    const latest = await withFreshReads(() => fetchSettings()).catch(() => undefined);
    if (!latest || !hasApprovalSettings(latest) || getGatewayApiBaseUrl() !== record.installation) return keepLocked();
    const outcome = settleApprovalModeUncertainty(record, latest, Boolean(active));
    if (outcome === "not_saved" && !finished) return keepLocked();
    clearApprovalModeUncertainty(record.installation);
    if (live.current.mounted) {
      if (outcome === "saved") {
        draft.acceptSaved(latest.toolApprovalMode, latest.revision, record.submitted);
        setNotice("Tool approval rule saved and confirmed by GoatCitadel.");
      } else if (outcome === "waiting" && active) {
        setWaiting(active);
        setNotice(describeWaitingChange(active, "rule"));
      } else setNotice("Your approval rule was not saved. Your draft is kept, so you can save it again.");
    } else if (outcome === "saved") draft.acceptSaved(latest.toolApprovalMode, latest.revision, record.submitted);
    await settings.refetch();
  }
  const reconcile = async () => {
    const record = currentApprovalModeUncertainty(getGatewayApiBaseUrl());
    if (record && !record.checking) await reconcileRecord(record);
  };
  /**
   * Looks at the earlier change a conflict (or a refresh) names: still open (shown), finished (nothing to show; the
   * saved rule speaks), not a Settings change (the ordinary conflict copy) or unreadable (kept, with its Inbox link).
   */
  async function followWaiting(planId: string): Promise<void> {
    const lookup = await findWaitingSettingsChange(planId);
    if (!live.current.mounted || getGatewayApiBaseUrl() !== installation) return;
    if (lookup.kind === "unreadable" && waiting && !("unreadable" in waiting)) return;
    const held = waitingNoticeFor(lookup, planId);
    setWaiting(held);
    if (held) setNotice(describeWaitingChange(held, "rule"));
    else {
      setNotice(
        lookup.kind === "foreign"
          ? "Not saved: the settings changed since your draft started. Your draft is kept for review."
          : null,
      );
      await settings.refetch();
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
    waiting,
    /** Called once the waiting change was decided: the saved rule is read again. */
    clearWaiting: () => {
      // The waiting sentence goes with the change; a notice set since stays.
      const sentence = waiting ? describeWaitingChange(waiting, "rule") : undefined;
      setNotice((shown) => (shown === sentence ? null : shown));
      setWaiting(null);
      void settings.refetch();
    },
    reconcile,
    /** Looks at a held waiting change again and clears it once it is no longer open. */
    recheckWaiting: async () => {
      if (waiting) await followWaiting(waiting.planId);
    },
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
