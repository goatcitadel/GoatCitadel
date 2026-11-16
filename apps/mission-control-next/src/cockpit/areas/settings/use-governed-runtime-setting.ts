import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
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
import {
  settingsChangeIsConfirmed,
  useSettingsChange,
} from "../../../features/native-routes/settings/use-settings-change";
import { useCockpitRoute } from "../../app/use-cockpit-route";

/** A single runtime setting value that one Settings control drafts and saves. */
export type GovernedSettingValue = string | boolean;
type SettingsPatch = Omit<Parameters<typeof patchSettings>[0], "expectedRevision">;
export type GovernedSettingNotice = { tone: "done" | "waiting" | "failed"; message: string };

const CHECKING_MESSAGE = "Checking whether your change was saved…";
const NOT_SAVED_MESSAGE = "Your change was not saved. Your draft is kept, so you can save it again.";
const UNCONFIRMED_MESSAGE =
  "GoatCitadel didn't answer, so this save isn't confirmed yet. Saving stays paused until it can be checked.";

/**
 * The save lifecycle shared by single-value runtime Settings controls: a session draft over the saved
 * revision, a re-read before the write, the Gateway change plan (receipt, approval, continuation), and what a
 * failed write means: an earlier change still waiting for approval (found again, its approval reopened), a plain
 * refusal (nothing applied, no lock), or a lost answer (the lock holds only until the saved value and the open
 * changes have been read again). Each control supplies only its value, patch and copy.
 *
 * The control owns the settings query, so its literal key stays visible to the settings
 * reader inventory (`SETTINGS_READER_KEYS`), which refreshes it after a settings change.
 */
export function useGovernedRuntimeSetting<T extends GovernedSettingValue>(options: {
  settings: UseQueryResult<RuntimeSettingsResponse>;
  draftKey: string;
  draftLabel: string;
  recovery: { path: string; anchor: string };
  /** Reads the saved value; `undefined` means the Gateway did not report a usable value. */
  read: (settings: RuntimeSettingsResponse) => T | undefined;
  fallback: T;
  patch: (value: T) => SettingsPatch;
  /**
   * The form the Gateway stores a submitted value in when it tidies it, such as an address it lower-cases and drops a
   * trailing slash from. A save is confirmed when the saved value equals this form, and the draft then shows it.
   */
  normalize?: (submitted: T) => T;
  /** Runs once for each save the saved settings confirm, with the value as saved, however long its approval took. */
  onSaved?: (saved: T) => void;
  operation: string;
  matchesPlan?: (plan: ChangePlanRecord, submitted: T) => boolean;
  copy: { staleDraft: string; changedElsewhere: string; saved: string };
}) {
  const route = useCockpitRoute();
  const parameters = new URLSearchParams(route.search);
  parameters.delete("shell");
  parameters.delete("shellScope");
  const recoveryHref = `${options.recovery.path}${parameters.size ? `?${parameters}` : ""}#${options.recovery.anchor}`;
  const { settings } = options;
  const saved = settings.data ? options.read(settings.data) : undefined;
  const current = saved ?? options.fallback;
  const ready = Boolean(
    settings.data &&
    !settings.isError &&
    saved !== undefined &&
    Number.isSafeInteger(settings.data.revision) &&
    settings.data.revision > 0,
  );
  const draft = useSessionDraft(options.draftKey, current, settings.data?.revision, {
    label: options.draftLabel,
    available: ready,
    onSave: () => save(),
  });
  const change = useSettingsChange<T>({
    key: draft.key,
    operation: options.operation,
    matchesPlan: options.matchesPlan,
    matches: (savedSettings, submitted) =>
      options.read(savedSettings) === (options.normalize?.(submitted) ?? submitted),
    ...(options.normalize ? { savedValue: options.normalize } : {}),
    acceptSaved: (savedValue, savedRevision, submitted) => {
      const clean = draft.acceptSaved(savedValue, savedRevision, submitted);
      options.onSaved?.(savedValue);
      return clean;
    },
    reload: () => reread(),
  });
  const [busy, setBusy] = useState(false);
  // Only this control's own reads (Try again, its save's re-read) hold its Save. A background refetch of the shared
  // settings query (the minute poll, another control's re-read) does not: save() reads the saved settings itself
  // before writing and compares the revision, so a moment-old shown value cannot be saved over a newer one.
  const [ownReads, setOwnReads] = useState(0);
  const readingOwn = ownReads > 0;
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState<GovernedSettingNotice | null>(null);
  const [waiting, setWaiting] = useState<WaitingSettingsNotice | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  async function reread() {
    setOwnReads((count) => count + 1);
    try {
      return await settings.refetch();
    } finally {
      if (mounted.current) setOwnReads((count) => count - 1);
    }
  }
  // The write that may or may not have been applied, kept so its outcome can be checked once the answer is lost.
  const attempt = useRef<{ submitted: T; baseRevision: number; transport?: TrackedAttempt } | null>(null);
  const checking = useRef(false);
  // A lookup that finishes after the control went away, or after another Gateway was chosen, must not land here.
  const installation = getGatewayApiBaseUrl();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirmed = settingsChangeIsConfirmed(change.change);

  /**
   * Saves the draft. A control whose draft has just been replaced by an action of its own, such as Clear, passes that
   * value: the draft it renders has not caught up yet, so the value to save is the one it names.
   */
  async function save(value?: T): Promise<boolean> {
    const submitted = value ?? draft.value;
    if (
      !ready ||
      !settings.data ||
      readingOwn ||
      draft.hasRemoteChanges ||
      !(value === undefined ? draft.isDirty : value !== current) ||
      outcomeUncertain ||
      waiting ||
      !change.beginSave()
    )
      return false;
    setBusy(true);
    setNotice(null);
    const baseRevision = Number(draft.baseRevision);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (latest.revision !== baseRevision || options.read(latest) !== current) {
        await reread();
        setNotice({ tone: "waiting", message: options.copy.staleDraft });
        return false;
      }
      mutationAttempted = true;
      const sentWrite: NonNullable<typeof attempt.current> = { submitted, baseRevision };
      attempt.current = sentWrite;
      const response = await sendTrackedSettingsSave(
        () => patchSettings({ expectedRevision: baseRevision, ...options.patch(submitted) }),
        (tracked) => {
          if (tracked) sentWrite.transport = tracked;
          else delete sentWrite.transport;
        },
      );
      const accepted = change.receive(response, submitted, baseRevision);
      setNotice({
        tone: accepted ? "done" : "waiting",
        message: accepted ? options.copy.saved : "Change submitted. Review its status before another save.",
      });
      await reread();
      return accepted;
    } catch (error) {
      const failure = classifySettingsSaveFailure(error);
      if (!mutationAttempted) {
        if (failure.kind === "conflict" || failure.kind === "waiting") {
          await reread();
          setNotice({ tone: "waiting", message: options.copy.changedElsewhere });
        } else {
          setNotice({
            tone: "failed",
            message: `Could not confirm current settings. ${describeApiError(error).summary}`,
          });
        }
      } else if (failure.kind === "waiting") {
        // An earlier change to this setting is still open: lead to its approval and keep the draft.
        await reread();
        await followWaiting(failure.planId);
      } else if (failure.kind === "conflict") {
        await reread();
        setNotice({ tone: "waiting", message: options.copy.changedElsewhere });
      } else if (failure.kind === "refused") {
        setNotice({ tone: "failed", message: `Not saved. ${failure.reason}` });
      } else {
        setOutcomeUncertain(true);
        setNotice({ tone: "waiting", message: CHECKING_MESSAGE });
        void checkOutcome();
      }
      return false;
    } finally {
      change.endSave();
      setBusy(false);
    }
  }

  /**
   * Looks at the earlier change a conflict (or a refresh) names and says what it is: still open (shown, with its
   * approval or link), finished (nothing to show; the saved setting speaks), not a Settings change (the ordinary
   * conflict copy), or unreadable (kept, with its Inbox link).
   */
  async function followWaiting(planId: string): Promise<void> {
    const lookup = await findWaitingSettingsChange(planId);
    if (!mounted.current || getGatewayApiBaseUrl() !== installation) return;
    if (lookup.kind === "unreadable" && waiting && !("unreadable" in waiting)) return;
    const held = waitingNoticeFor(lookup, planId);
    setWaiting(held);
    if (held) setNotice({ tone: "waiting", message: describeWaitingChange(held) });
    else {
      setNotice(lookup.kind === "foreign" ? { tone: "waiting", message: options.copy.changedElsewhere } : null);
      await reread();
    }
  }

  /**
   * After a save whose answer was lost: first asks the Gateway whether that very request has finished. Reads of the
   * open changes and the saved value say "not saved" only once it has, because a request still running can apply after
   * both reads. Then it reads the open changes first and the saved value second, so a change that finishes in between
   * shows up as the saved value. All reads are made after the write, never joined to an older one. Saving stays paused
   * while the request may still be running or a read fails; neither is ever reported as "not saved".
   */
  async function checkOutcome(): Promise<void> {
    const sent = attempt.current;
    if (!sent || checking.current) return;
    checking.current = true;
    setCheckingOutcome(true);
    const keepLocked = () => setNotice({ tone: "failed", message: UNCONFIRMED_MESSAGE });
    try {
      const expected = options.normalize?.(sent.submitted) ?? sent.submitted;
      // Without an attempt identity nothing can say the request is over, so "not saved" cannot be concluded below.
      const finished = sent.transport ? await settingsSaveFinished(sent.transport) : false;
      if (sent.transport && !finished) return keepLocked();
      const active = await findActiveSettingsChange(
        (plan) =>
          options.matchesPlan?.(plan, sent.submitted) ??
          (plan.kind === "runtime_configuration" &&
            plan.request.kind === "runtime_configuration" &&
            plan.request.change.operation === options.operation &&
            plan.target.ownerId === "runtime_settings"),
      );
      if (active === "unreadable") return keepLocked();
      const latest = await withFreshReads(() => fetchSettings()).catch(() => undefined);
      const savedValue = latest ? options.read(latest) : undefined;
      if (!latest || savedValue === undefined) return keepLocked();
      if (savedValue === expected && latest.revision > sent.baseRevision) {
        draft.acceptSaved(savedValue, latest.revision, sent.submitted);
        options.onSaved?.(savedValue);
        setOutcomeUncertain(false);
        setNotice({ tone: "done", message: options.copy.saved });
        await reread();
        return;
      }
      if (!active && !finished) return keepLocked();
      setOutcomeUncertain(false);
      if (active) {
        setWaiting(active);
        setNotice({ tone: "waiting", message: describeWaitingChange(active) });
      } else setNotice({ tone: "failed", message: NOT_SAVED_MESSAGE });
      await reread();
    } finally {
      checking.current = false;
      setCheckingOutcome(false);
    }
  }
  return {
    settings,
    ready,
    current,
    draft,
    change,
    confirmed,
    busy,
    /** This control's own re-read is running (not the shared minute poll). */
    reading: readingOwn,
    outcomeUncertain,
    notice,
    waiting,
    /** Called once the waiting change was decided: the control reads the saved setting again. */
    clearWaiting: () => {
      // The waiting sentence goes with the change; a notice set since stays.
      const sentence = waiting ? describeWaitingChange(waiting) : undefined;
      setNotice((shown) => (shown && shown.message === sentence ? null : shown));
      setWaiting(null);
      void reread();
    },
    checkOutcome,
    checkingOutcome,
    // While a change is waiting, its sentence is the notice and stays until the change is settled.
    clearNotice: () => {
      if (!waiting) setNotice(null);
    },
    /** Controls stay read-only while a save, a pending change or an unknown outcome is outstanding. */
    locked: busy || change.hasPending || outcomeUncertain,
    canSave:
      draft.isDirty &&
      !draft.hasRemoteChanges &&
      !busy &&
      !readingOwn &&
      !change.hasPending &&
      !outcomeUncertain &&
      !waiting,
    save,
    refresh: () => {
      void reread();
      if (change.change) void change.refresh();
      if (waiting) void followWaiting(waiting.planId);
    },
    recoveryHref,
  };
}

export type GovernedRuntimeSetting<T extends GovernedSettingValue> = ReturnType<typeof useGovernedRuntimeSetting<T>>;
