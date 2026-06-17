import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
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
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
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
    <NativeCard density="compact" className="mc-next-settings-panel"
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
    </NativeCard>
  );

  return (
    <>
      {error ? <ErrorState size="inline" description={error} /> : null}
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid>
        {data ? (
          <NativeCard density="compact" className="mc-next-settings-panel"
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
              <NativeButton
                variant="default"
                disabled={savingBudgetMode || budgetDraft === currentBudgetMode}
                onClick={() => void saveBudgetMode()}
              >
                <Save size={16} />
                {savingBudgetMode ? "Saving..." : "Save budget mode"}
              </NativeButton>
              <NativeButton
                variant="secondary"
                disabled={savingBudgetMode}
                onClick={() => void reload()}
              >
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
        ) : (
          <NativeCard density="compact" className="mc-next-settings-panel"
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
        {costEvidencePanel}
      </SettingsGrid>
    </>
  );
}
