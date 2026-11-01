import { useQuery } from "@tanstack/react-query";
import { CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";

export const BROWSER_ERRANDS_ANCHOR = "browser-errands";
const FLAG = "browserErrandsEnabled";
const LABEL = CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[FLAG];
const WEB_ACCESS_NOTE =
  "Errands also need Web access turned on in Chat. While Web access is Off, Chat does not offer browser errands.";
const onOff = (value: boolean) => (value ? "On" : "Off");
const readFlag = (settings: RuntimeSettingsResponse) => {
  const value = settings.features?.[FLAG];
  return typeof value === "boolean" ? value : undefined;
};
/** Only a plan for this exact flag and value settles this draft. */
const matchesPlan = (plan: ChangePlanRecord, submitted: boolean) =>
  plan.kind === "runtime_configuration" &&
  plan.request.kind === "runtime_configuration" &&
  plan.request.change.operation === "feature_flag" &&
  plan.request.change.flag === FLAG &&
  plan.request.change.enabled === submitted &&
  plan.target.ownerId === "runtime_settings";

export function BrowserErrandsControl() {
  const query = useQuery({
    queryKey: ["system", "settings-browser-errands"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: "features:system:browser-errands",
    draftLabel: LABEL?.label ?? "Browser errands",
    recovery: { path: "/settings/tools", anchor: BROWSER_ERRANDS_ANCHOR },
    read: readFlag,
    fallback: false,
    patch: (value) => ({ features: { [FLAG]: value } }),
    operation: "feature_flag",
    matchesPlan,
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current setting, then apply your draft to the latest version before retrying.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Setting saved.",
    },
  });
  const { settings, ready, current, draft } = governed;

  return (
    <section
      id={BROWSER_ERRANDS_ANCHOR}
      aria-labelledby="browser-errands-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="browser-errands-title" className="text-md font-semibold text-fg">
            {LABEL?.label}
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">{LABEL?.description}</p>
        </div>
        <Button size="sm" disabled={settings.isFetching || governed.busy} onClick={governed.refresh}>
          Refresh
        </Button>
      </div>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading setting…"
        incomplete="GoatCitadel did not report this setting. Refresh, or update GoatCitadel, before changing it."
      />
      {ready ? (
        <>
          <p className="mt-3 text-xs text-fg-muted">Current: {onOff(current)}</p>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              features.{FLAG} · Settings version {settings.data?.revision}
            </p>
          </TechnicalDetails>
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={draft.value}
              aria-describedby="browser-errands-note"
              disabled={governed.locked}
              onChange={(event) => {
                governed.clearNotice();
                draft.setValue(event.target.checked);
              }}
            />
            Let Chat do errands in its own browser window
          </label>
          <p id="browser-errands-note" className="mt-2 text-xs text-fg-muted">
            {WEB_ACCESS_NOTE}
          </p>
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${onOff(draft.value)}`}
            currentLabel={onOff(current)}
          />
          <Button variant="primary" className="mt-3" disabled={!governed.canSave} onClick={() => void governed.save()}>
            {governed.busy ? "Saving…" : "Save setting"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="browser-errands"
        recoveryLabel="Inspect Browser errands setting activity"
      />
    </section>
  );
}
