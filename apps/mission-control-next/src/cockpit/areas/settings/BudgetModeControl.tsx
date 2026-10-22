import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";

type BudgetMode = RuntimeSettingsResponse["budgetMode"];
const BUDGET_MODE_LABELS: Record<BudgetMode, string> = { saver: "Saver", balanced: "Balanced", power: "Power" };
const MODES = Object.keys(BUDGET_MODE_LABELS) as BudgetMode[];
/**
 * What each mode means today. The Gateway only stores the mode: nothing reads it to pick models
 * or to stop spending, so the copy must not promise either.
 */
const BUDGET_MODE_HELP: Record<BudgetMode, string> = {
  saver: "Your preference is lower cost.",
  balanced: "The everyday default: no lean toward cost or quality.",
  power: "Your preference is answer quality over cost.",
};
const BUDGET_MODE_SCOPE = "Saved as a preference only: no mode switches models or caps spending today.";
const budgetModeLabel = (mode: BudgetMode | undefined) => (mode ? (BUDGET_MODE_LABELS[mode] ?? "Unknown") : "Unknown");

function isBudgetMode(value: unknown): value is BudgetMode {
  return MODES.includes(value as BudgetMode);
}

export function BudgetModeControl() {
  const query = useQuery({
    queryKey: ["system", "settings-budget-mode"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<BudgetMode>({
    settings: query,
    draftKey: "budget:system:mode",
    draftLabel: "Budget preference",
    recovery: { path: "/settings/safety", anchor: "budget-mode" },
    read: (settings) => (isBudgetMode(settings.budgetMode) ? settings.budgetMode : undefined),
    fallback: "balanced",
    patch: (mode) => ({ budgetMode: mode }),
    operation: "budget_mode",
    copy: {
      staleDraft:
        "Budget settings changed. Your draft started from an older version. Review the current mode, then apply your draft to the latest version before retrying.",
      changedElsewhere: "Budget settings changed elsewhere. Your draft is preserved for review.",
      saved: "Budget preference saved.",
    },
  });
  const { settings, ready, current, draft } = governed;

  return (
    <section
      id="budget-mode"
      aria-labelledby="budget-mode-title"
      className="mt-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="budget-mode-title" className="text-md font-semibold text-fg">
            Budget preference
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            A saved preference for how much to spend on models. This is not a dollar limit.
          </p>
        </div>
        <Button size="sm" disabled={settings.isFetching || governed.busy} onClick={governed.refresh}>
          Refresh
        </Button>
      </div>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading budget preference…"
        incomplete="GoatCitadel returned an incomplete budget setting. Refresh the current setting before changing this preference."
      />
      {ready ? (
        <>
          <p className="mt-3 text-xs text-fg-muted">Current: {budgetModeLabel(current)}</p>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">Settings version {settings.data?.revision}</p>
          </TechnicalDetails>
          <div className="mt-3 max-w-sm">
            <Field label="Mode" help={BUDGET_MODE_SCOPE}>
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  className={cockpitInputClass}
                  value={draft.value}
                  onChange={(event) => {
                    governed.clearNotice();
                    draft.setValue(event.target.value as BudgetMode);
                  }}
                  disabled={governed.locked}
                >
                  {MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {BUDGET_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <dl className="mt-2 space-y-1 text-xs text-fg-muted">
            {MODES.map((mode) => (
              <div key={mode}>
                <dt className="inline font-medium text-fg-secondary">{BUDGET_MODE_LABELS[mode]}: </dt>
                <dd className="inline">{BUDGET_MODE_HELP[mode]}</dd>
              </div>
            ))}
          </dl>
          <GovernedSettingDraftState
            governed={governed}
            unsaved="Unsaved preference draft"
            currentLabel={budgetModeLabel(current)}
          />
          <Button variant="primary" className="mt-3" disabled={!governed.canSave} onClick={() => void governed.save()}>
            {governed.busy ? "Saving…" : "Save preference"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="budget-mode"
        recoveryLabel="Inspect budget settings activity"
      />
    </section>
  );
}
