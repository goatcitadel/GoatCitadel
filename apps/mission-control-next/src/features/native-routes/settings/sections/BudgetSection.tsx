import { SettingsChangeStatus, useSettingsChange } from "../use-settings-change";
import { useSessionDraft } from "../../library/session-drafts";
import { useCallback, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { fetchSettings, isApiRequestError, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  type Notice,
  type SettingsSectionProps,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsStack,
  SettingsNotice,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import {
  BUDGET_MODE_OPTIONS,
  describeBudgetMode,
  labelForBudgetMode,
  normalizeBudgetMode,
} from "../../SettingsNativePage";
import { ErrorState, NativeButton } from "../../primitives";

export function BudgetSection({ route, navigate }: SettingsSectionProps) {
  const load = useCallback(() => fetchSettings(), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const editor = useSessionDraft("budget:system:mode", normalizeBudgetMode(data?.budgetMode), data?.revision, {
    label: "Budget mode", available: Boolean(data), onSave: () => saveBudgetMode(),
  });
  const budgetChange = useSettingsChange({ key: editor.key, operation: "budget_mode", matches: (settings, submitted: typeof editor.value) => settings.budgetMode === submitted, acceptSaved: editor.acceptSaved, reload });
  const budgetDraft = editor.value;
  const setBudgetDraft = editor.setValue;
  const [savingBudgetMode, setSavingBudgetMode] = useState(false);
  const savingBudgetModeRef = useRef(false);
  const currentBudgetMode = normalizeBudgetMode(data?.budgetMode);
  const saveBudgetMode = async (): Promise<boolean> => {
    if (budgetChange.isPending()) { await budgetChange.refresh(); return false; }
    if (savingBudgetModeRef.current) {
      return false;
    }
    if (!data) {
      setNotice({ tone: "warning", message: "Reload settings before saving the budget mode." });
      return false;
    }
    if (editor.hasRemoteChanges) {
      setNotice({ tone: "warning", message: "Review the current budget mode before applying your draft to the latest revision." });
      return false;
    }
    const submitted = budgetDraft;
    try {
      savingBudgetModeRef.current = true;
      setSavingBudgetMode(true);
      const updated = await patchSettings({ expectedRevision: Number(editor.baseRevision ?? data.revision), budgetMode: submitted });
      const clean = budgetChange.receive(updated, submitted, Number(editor.baseRevision ?? data.revision));
      if (clean) setNotice({ tone: "success", message: "Budget mode saved." });
      await reload();
      return clean;
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Budget settings changed elsewhere. Your draft is preserved; review the current settings, then save again to retry.",
        });
        return false;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return false;
    } finally {
      savingBudgetModeRef.current = false;
      setSavingBudgetMode(false);
    }
  };

  if (loading && !data) {
    return (
      <SettingsSectionShell loading={loading} error={null}>
        {null}
      </SettingsSectionShell>
    );
  }

  const costEvidencePanel = (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Cost evidence"
      subtitle="Inspect the runtime signals that explain spend, routing, and provider behavior."
    >
      <SettingsActionList
        ariaLabel="Budget evidence routes"
        items={[
          {
            label: "Open cost telemetry",
            description: "Review provider usage and budget-facing runtime evidence in Ops.",
            onClick: () => navigate({ area: "ops", section: "costs", theme: route.theme }),
          },
          {
            label: "Tune provider routing",
            description: "Change active model routing where cost, latency, and fallback choices are made.",
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
        ]}
      />
    </NativeCard>
  );

  return (
    <>
      {error ? <ErrorState size="inline" description={error} /> : null}
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsChangeStatus change={budgetChange.change} onRefresh={budgetChange.refresh} navigate={navigate} route={route} />
      <SettingsStack>
        {data ? (
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Budget mode"
            subtitle="Set the default cost posture used by runtime settings and first-run defaults."
            stats={[
              { label: "Current", value: labelForBudgetMode(currentBudgetMode) },
              { label: "Selected", value: labelForBudgetMode(budgetDraft) },
            ]}
          >
            {editor.isDirty ? <p role="status">Unsaved budget draft</p> : null}
            {editor.hasRemoteChanges ? <div role="status"><p>Current saved mode: {labelForBudgetMode(currentBudgetMode)}. Your draft is preserved.</p><NativeButton variant="outline" onClick={editor.rebaseToCurrent}>Apply draft to current budget</NativeButton></div> : null}
            <SettingsFieldGrid>
              <SettingsField label="Mode">
                <select
                  className="mc-next-settings-input"
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(normalizeBudgetMode(event.target.value))}
                >
                  {BUDGET_MODE_OPTIONS.map((mode) => (
                    <option key={mode} value={mode}>
                      {labelForBudgetMode(mode)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">{describeBudgetMode(budgetDraft)}</p>
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsButtonRow>
              <NativeButton
                variant="default"
                disabled={savingBudgetMode || budgetChange.hasPending || !editor.isDirty || editor.hasRemoteChanges}
                onClick={() => void saveBudgetMode()}
              >
                <Save size={16} />
                {savingBudgetMode ? "Saving..." : "Save budget mode"}
              </NativeButton>
              <NativeButton variant="secondary" disabled={savingBudgetMode} onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
        ) : (
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Budget mode unavailable"
            subtitle="Budget mode could not be loaded, but cost and provider evidence remain reachable."
          >
            <p className="mc-next-settings-field-note">
              Refresh the route to retry the settings read before changing the runtime budget posture.
            </p>
            <SettingsButtonRow>
              <NativeButton variant="secondary" onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
        )}
        <NativeDisclosureCard id="budget-cost-evidence" title="Cost evidence">{costEvidencePanel}</NativeDisclosureCard>
      </SettingsStack>
    </>
  );
}
