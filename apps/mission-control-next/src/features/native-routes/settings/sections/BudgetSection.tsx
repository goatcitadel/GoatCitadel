import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Save } from "lucide-react";
import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  type Notice,
  type SettingsSectionProps,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsNotice,
  SettingsPanel,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import {
  BUDGET_MODE_OPTIONS,
  describeBudgetMode,
  labelForBudgetMode,
  normalizeBudgetMode,
} from "../../SettingsNativePage";

export function BudgetSection({ route, navigate }: SettingsSectionProps) {
  const load = useCallback(() => fetchSettings(), []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<ReturnType<typeof normalizeBudgetMode>>("balanced");
  const [savingBudgetMode, setSavingBudgetMode] = useState(false);
  const savingBudgetModeRef = useRef(false);

  useEffect(() => {
    if (data) {
      setBudgetDraft(normalizeBudgetMode(data.budgetMode));
    }
  }, [data]);

  const currentBudgetMode = normalizeBudgetMode(data?.budgetMode);
  const saveBudgetMode = async () => {
    if (savingBudgetModeRef.current) {
      return;
    }
    try {
      savingBudgetModeRef.current = true;
      setSavingBudgetMode(true);
      await patchSettings({ budgetMode: budgetDraft });
      setNotice({ tone: "success", message: "Budget mode saved." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      savingBudgetModeRef.current = false;
      setSavingBudgetMode(false);
    }
  };

  if (loading) {
    return (
      <SettingsSectionShell loading={loading} error={null}>
        {null}
      </SettingsSectionShell>
    );
  }

  const costEvidencePanel = (
    <SettingsPanel
      title="Cost evidence"
      subtitle="Inspect the runtime signals that explain spend, routing, and provider behavior."
    >
      <SettingsActionList
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
    </SettingsPanel>
  );

  return (
    <>
      {error ? (
        <div className="mc-next-directory-alert">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid>
        {data ? (
          <SettingsPanel
            title="Budget mode"
            subtitle="Set the default cost posture used by runtime settings and first-run defaults."
            stats={[
              { label: "Current", value: labelForBudgetMode(currentBudgetMode) },
              { label: "Selected", value: labelForBudgetMode(budgetDraft) },
            ]}
          >
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
              <button
                type="button"
                className="mc-next-button"
                disabled={savingBudgetMode || budgetDraft === currentBudgetMode}
                onClick={() => void saveBudgetMode()}
              >
                <Save size={16} />
                {savingBudgetMode ? "Saving..." : "Save budget mode"}
              </button>
              <button
                type="button"
                className="mc-next-button-secondary"
                disabled={savingBudgetMode}
                onClick={() => void reload()}
              >
                <RefreshCw size={16} />
                Refresh
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        ) : (
          <SettingsPanel
            title="Budget mode unavailable"
            subtitle="Budget mode could not be loaded, but cost and provider evidence remain reachable."
          >
            <p className="mc-next-settings-field-note">
              Refresh the route to retry the settings read before changing the runtime budget posture.
            </p>
            <SettingsButtonRow>
              <button type="button" className="mc-next-button-secondary" onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        )}
        {costEvidencePanel}
      </SettingsGrid>
    </>
  );
}
