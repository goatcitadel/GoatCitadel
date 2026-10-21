import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings, isApiRequestError, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  settingsChangeIsConfirmed,
  useSettingsChange,
} from "../../../features/native-routes/settings/use-settings-change";
import { useCockpitRoute } from "../../app/use-cockpit-route";

/** A single runtime setting value that one Settings control drafts and saves. */
export type GovernedSettingValue = string | boolean;
type SettingsPatch = Omit<Parameters<typeof patchSettings>[0], "expectedRevision">;
export type GovernedSettingNotice = { tone: "done" | "waiting" | "failed"; message: string };

/**
 * The save lifecycle shared by single-value runtime Settings controls: a session draft over the saved
 * revision, a re-read before the write, the Gateway change plan (receipt, approval, continuation), and a
 * lock after a write whose outcome is unknown. Each control supplies only its value, patch and copy.
 */
export function useGovernedRuntimeSetting<T extends GovernedSettingValue>(options: {
  queryKey: readonly unknown[];
  draftKey: string;
  draftLabel: string;
  recovery: { path: string; anchor: string };
  /** Reads the saved value; `undefined` means the Gateway did not report a usable value. */
  read: (settings: RuntimeSettingsResponse) => T | undefined;
  fallback: T;
  patch: (value: T) => SettingsPatch;
  operation: string;
  matchesPlan?: (plan: ChangePlanRecord, submitted: T) => boolean;
  copy: { staleDraft: string; changedElsewhere: string; saved: string };
}) {
  const route = useCockpitRoute();
  const parameters = new URLSearchParams(route.search);
  parameters.delete("shell");
  parameters.delete("shellScope");
  const recoveryHref = `${options.recovery.path}${parameters.size ? `?${parameters}` : ""}#${options.recovery.anchor}`;
  const settings = useQuery({ queryKey: options.queryKey, queryFn: fetchSettings, refetchInterval: 60_000 });
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
    matches: (savedSettings, submitted) => options.read(savedSettings) === submitted,
    acceptSaved: draft.acceptSaved,
    reload: () => settings.refetch(),
  });
  const [busy, setBusy] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState<GovernedSettingNotice | null>(null);
  const confirmed = settingsChangeIsConfirmed(change.change);

  async function save(): Promise<boolean> {
    if (
      !ready ||
      !settings.data ||
      settings.isFetching ||
      draft.hasRemoteChanges ||
      !draft.isDirty ||
      outcomeUncertain ||
      !change.beginSave()
    )
      return false;
    setBusy(true);
    setNotice(null);
    const submitted = draft.value;
    const baseRevision = Number(draft.baseRevision);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (latest.revision !== baseRevision || options.read(latest) !== current) {
        await settings.refetch();
        setNotice({ tone: "waiting", message: options.copy.staleDraft });
        return false;
      }
      mutationAttempted = true;
      const response = await patchSettings({ expectedRevision: baseRevision, ...options.patch(submitted) });
      const accepted = change.receive(response, submitted, baseRevision);
      setNotice({
        tone: accepted ? "done" : "waiting",
        message: accepted ? options.copy.saved : "Change submitted. Review its Gateway status before another save.",
      });
      await settings.refetch();
      return accepted;
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        await settings.refetch();
        setNotice({ tone: "waiting", message: options.copy.changedElsewhere });
      } else {
        if (mutationAttempted) setOutcomeUncertain(true);
        setNotice({
          tone: "failed",
          message: mutationAttempted
            ? `Save outcome is uncertain. Inspect Settings activity before another request. ${describeApiError(error).summary}`
            : `Could not confirm current settings. ${describeApiError(error).summary}`,
        });
      }
      return false;
    } finally {
      change.endSave();
      setBusy(false);
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
    outcomeUncertain,
    notice,
    clearNotice: () => setNotice(null),
    /** Controls stay read-only while a save, a pending change or an unknown outcome is outstanding. */
    locked: busy || change.hasPending || outcomeUncertain,
    canSave:
      draft.isDirty &&
      !draft.hasRemoteChanges &&
      !busy &&
      !settings.isFetching &&
      !change.hasPending &&
      !outcomeUncertain,
    save,
    refresh: () => {
      void settings.refetch();
      if (change.change) void change.refresh();
    },
    recoveryHref,
  };
}

export type GovernedRuntimeSetting<T extends GovernedSettingValue> = ReturnType<typeof useGovernedRuntimeSetting<T>>;
