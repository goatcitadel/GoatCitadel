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

export const SETTINGS_APPROVAL_SKIP_ANCHOR = "settings-approval-skip";
const FLAG = "settingsApprovalSkipEnabled";
/** What the switch does and does not change, as the Gateway enforces it. */
const SKIP_FACTS = [
  "Covers saves through the Settings forms, such as the network allowlist, Firecrawl, approval mode and runtime switches, connectors you install from Capabilities, and skills you switch on from Capabilities. GoatCitadel sign-in, API keys and other credentials still ask for approval.",
  "Turning a skill off, or pausing one that is on, from Capabilities applies right away even when this is off, because it only takes power away; a remote-hardened install still asks. Skill changes made anywhere else, such as Chat's skill commands, still ask.",
  "Change requests a model makes in Chat still need your approval. Anything that can call the Settings or Capabilities API as you, such as a script on this computer while GoatCitadel sign-in is off, can also make these changes without one.",
  "Each Settings change and connector install is still recorded as a change plan, with its audit trail and any undo it supports. A skill switch keeps its approval, marked as approved by you, with the reason.",
  "Turning this on needs one last approval. A remote-hardened install ignores it.",
];
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

export function SettingsApprovalSkipControl() {
  const query = useQuery({
    queryKey: ["system", "settings-approval-skip"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: "features:system:settings-approval-skip",
    draftLabel: "Settings approvals",
    recovery: { path: "/settings/safety", anchor: SETTINGS_APPROVAL_SKIP_ANCHOR },
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
      id={SETTINGS_APPROVAL_SKIP_ANCHOR}
      aria-labelledby="settings-approval-skip-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="settings-approval-skip-title" className="text-md font-semibold text-fg">
            {CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[FLAG]?.label}
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Off by default. When on, Settings changes such as the network allowlist, connectors you install from
            Capabilities and skills you switch on there apply right away instead of waiting for your approval.
          </p>
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
              aria-describedby="settings-approval-skip-facts"
              disabled={governed.locked}
              onChange={(event) => {
                governed.clearNotice();
                draft.setValue(event.target.checked);
              }}
            />
            Apply my Settings and Capabilities changes without asking first
          </label>
          <ul id="settings-approval-skip-facts" className="mt-2 list-inside list-disc space-y-1 text-xs text-fg-muted">
            {SKIP_FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
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
        owner="settings-approval-skip"
        recoveryLabel="Inspect Settings approval setting activity"
      />
    </section>
  );
}
