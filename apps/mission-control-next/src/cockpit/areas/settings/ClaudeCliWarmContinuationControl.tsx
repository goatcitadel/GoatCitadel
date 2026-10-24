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

export const CLAUDE_CLI_WARM_CONTINUATION_ANCHOR = "claude-cli-warm-continuation";
const FLAG = "claudeCliWarmContinuationEnabled";
const COPY =
  "When a tool step continues the previous one exactly, keeps that turn's Claude Code process running instead of starting a new one; any other step still starts a new one. Tools still run in GoatCitadel. Experimental and on by default. Turn it off to start a new Claude Code process for every tool step.";
const onOff = (value: boolean) => (value ? "On" : "Off");
const readFlag = (settings: RuntimeSettingsResponse) => {
  const value = settings.features?.[FLAG];
  return typeof value === "boolean" ? value : undefined;
};
/** The switch only applies to bridged tool steps, so it waits for the tool bridge to be reported on. */
const bridgeIsOn = (settings: RuntimeSettingsResponse | undefined) =>
  settings?.features?.claudeCliToolBridgeEnabled === true;
/** Only a plan for this exact flag and value settles this draft. */
const matchesPlan = (plan: ChangePlanRecord, submitted: boolean) =>
  plan.kind === "runtime_configuration" &&
  plan.request.kind === "runtime_configuration" &&
  plan.request.change.operation === "feature_flag" &&
  plan.request.change.flag === FLAG &&
  plan.request.change.enabled === submitted &&
  plan.target.ownerId === "runtime_settings";

export function ClaudeCliWarmContinuationControl() {
  const query = useQuery({
    queryKey: ["system", "settings-claude-cli-warm-continuation"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: "features:system:claude-cli-warm-continuation",
    draftLabel: "Claude Code CLI faster tool steps",
    recovery: { path: "/settings/models", anchor: CLAUDE_CLI_WARM_CONTINUATION_ANCHOR },
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
  const bridgeOn = bridgeIsOn(settings.data);
  // Only the turn-ON direction waits for the bridge; a stale On value or draft can always be turned off.
  const blockedOn = !bridgeOn && !draft.value;

  return (
    <section
      id={CLAUDE_CLI_WARM_CONTINUATION_ANCHOR}
      aria-labelledby="claude-cli-warm-continuation-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="claude-cli-warm-continuation-title" className="text-md font-semibold text-fg">
            {CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[FLAG]?.label}
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">{COPY}</p>
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
              aria-describedby="claude-cli-warm-continuation-note"
              disabled={governed.locked || blockedOn}
              onChange={(event) => {
                governed.clearNotice();
                draft.setValue(event.target.checked);
              }}
            />
            Keep one Claude Code process between tool steps
          </label>
          <p id="claude-cli-warm-continuation-note" className="mt-2 text-xs text-fg-muted">
            {bridgeOn
              ? "Applies to Chat turns where the Claude Code CLI uses GoatCitadel tools."
              : "Turn on “Let the Claude Code CLI use GoatCitadel tools” first. This setting only applies to tool steps."}
          </p>
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${onOff(draft.value)}`}
            currentLabel={onOff(current)}
          />
          <Button
            variant="primary"
            className="mt-3"
            disabled={!governed.canSave || (!bridgeOn && draft.value)}
            onClick={() => void governed.save()}
          >
            {governed.busy ? "Saving…" : "Save setting"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="claude-cli-warm-continuation"
        recoveryLabel="Inspect Claude Code CLI faster tool steps setting activity"
      />
    </section>
  );
}
