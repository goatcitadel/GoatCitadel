import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSettings, isApiRequestError, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { settingsChangeIsConfirmed, useSettingsChange } from "../../../features/native-routes/settings/use-settings-change";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";

type BudgetMode = RuntimeSettingsResponse["budgetMode"];
const MODES: readonly BudgetMode[] = ["saver", "balanced", "power"];

function isBudgetMode(value: unknown): value is BudgetMode {
  return MODES.includes(value as BudgetMode);
}

export function BudgetModeControl() {
  const settings = useQuery({ queryKey: ["system", "settings-budget-mode"], queryFn: fetchSettings, refetchInterval: 60_000 });
  const current = isBudgetMode(settings.data?.budgetMode) ? settings.data.budgetMode : "balanced";
  const ready = Boolean(settings.data && !settings.isError && isBudgetMode(settings.data.budgetMode)
    && Number.isSafeInteger(settings.data.revision) && settings.data.revision > 0);
  const draft = useSessionDraft("budget:system:mode", current, settings.data?.revision, {
    label: "Budget preference", available: ready, onSave: () => save(),
  });
  const change = useSettingsChange<BudgetMode>({ key: draft.key, operation: "budget_mode",
    matches: (saved, submitted) => saved.budgetMode === submitted, acceptSaved: draft.acceptSaved,
    reload: () => settings.refetch() });
  const [busy, setBusy] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState<{ tone: "done" | "waiting" | "failed"; message: string } | null>(null);
  const confirmed = settingsChangeIsConfirmed(change.change);

  async function save(): Promise<boolean> {
    if (!ready || !settings.data || settings.isFetching || draft.hasRemoteChanges || !draft.isDirty
      || outcomeUncertain || !change.beginSave()) return false;
    setBusy(true);
    setNotice(null);
    const submitted = draft.value;
    const baseRevision = Number(draft.baseRevision);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (latest.revision !== baseRevision || latest.budgetMode !== current) {
        await settings.refetch();
        setNotice({ tone: "waiting", message: "Budget settings changed. Review the current mode and rebase your saved draft before retrying." });
        return false;
      }
      mutationAttempted = true;
      const response = await patchSettings({ expectedRevision: baseRevision, budgetMode: submitted });
      const saved = change.receive(response, submitted, baseRevision);
      setNotice({ tone: saved ? "done" : "waiting", message: saved ? "Budget preference saved." : "Change submitted. Review its Gateway status before another save." });
      await settings.refetch();
      return saved;
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        await settings.refetch();
        setNotice({ tone: "waiting", message: "Budget settings changed elsewhere. Your draft is preserved for review." });
      } else {
        if (mutationAttempted) setOutcomeUncertain(true);
        setNotice({ tone: "failed", message: mutationAttempted
          ? `Save outcome is uncertain. Inspect Settings activity before another request. ${describeApiError(error).summary}`
          : `Could not confirm current settings. ${describeApiError(error).summary}` });
      }
      return false;
    } finally {
      change.endSave();
      setBusy(false);
    }
  }

  return <section id="budget-mode" aria-labelledby="budget-mode-title" className="mt-4 rounded-lg border border-line bg-sunken p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id="budget-mode-title" className="font-display text-base font-semibold text-fg">Budget preference</h3>
        <p className="mt-1 text-sm text-fg-secondary">A saved cost posture for operator review. This is not a dollar limit.</p></div>
      <Button size="sm" disabled={settings.isFetching || busy} onClick={() => { void settings.refetch(); if (change.change) void change.refresh(); }}>Refresh</Button>
    </div>
    {settings.isLoading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading budget preference…</p> : null}
    {settings.isError ? <p role="alert" className="mt-3 text-sm text-status-failed">{describeApiError(settings.error).summary}</p> : null}
    {settings.data && !settings.isError && !ready ? <p role="alert" className="mt-3 text-sm text-status-failed">Gateway returned an incomplete budget setting. Review it in the classic Settings view.</p> : null}
    {ready ? <>
      <p className="mt-3 text-xs text-fg-muted">Current: {humanizeToken(current)} · settings revision {settings.data?.revision}</p>
      <label className="mt-3 block max-w-sm text-sm font-medium text-fg">Mode
        <select className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg" value={draft.value}
          onChange={(event) => { setNotice(null); draft.setValue(event.target.value as BudgetMode); }} disabled={busy || change.hasPending || outcomeUncertain}>
          {MODES.map((mode) => <option key={mode} value={mode}>{humanizeToken(mode)}</option>)}
        </select>
      </label>
      {draft.isDirty ? <p role="status" className="mt-2 text-xs text-status-waiting">Unsaved preference draft</p> : null}
      {draft.hasRemoteChanges ? <div role="status" className="mt-2 space-y-2 text-sm text-fg-secondary">
        <p>The saved setting changed after this draft began. Current: {humanizeToken(current)}.</p>
        <Button size="sm" onClick={draft.rebaseToCurrent}>Review draft against current revision</Button>
      </div> : null}
      <Button variant="primary" className="mt-3" disabled={!draft.isDirty || draft.hasRemoteChanges || busy || settings.isFetching || change.hasPending || outcomeUncertain}
        onClick={() => void save()}>{busy ? "Saving…" : "Save preference"}</Button>
    </> : null}
    {change.change ? <div className="mt-3 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
      <p role="status"><strong className="text-fg">{humanizeToken(change.change.receipt.status)}</strong> · {change.change.message}</p>
      {change.change.error ? <p role="alert" className="mt-1 text-status-failed">{change.change.error}</p> : null}
      {change.change.blocking ? <p className="mt-1">The draft remains unsaved until the Gateway confirms the change.</p> : null}
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" onClick={() => void change.refresh()}>Refresh change status</Button>
        {change.change.receipt.requiredAction?.kind === "approval" && !confirmed ? <ClassicOwnerLink href="/ops/approvals?shell=classic" scope={draft.key} className="text-sm font-medium text-accent hover:underline" label="Review approval" /> : null}</div>
      {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
    </div> : null}
    {notice && !(confirmed && notice.message.startsWith("Change submitted.")) ? <p role={notice.tone === "failed" ? "alert" : "status"} className={`mt-3 text-sm ${notice.tone === "failed" ? "text-status-failed" : notice.tone === "waiting" ? "text-status-waiting" : "text-status-done"}`}>{notice.message}</p> : null}
    {outcomeUncertain ? <ClassicOwnerLink href="/settings/budget?shell=classic" scope={draft.key} className="mt-3 inline-block text-sm font-medium text-accent hover:underline" label="Inspect budget settings in the classic view" /> : null}
  </section>;
}
