import { useQuery } from "@tanstack/react-query";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
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

export const CLAUDE_CLI_TOOL_BRIDGE_ANCHOR = "claude-cli-tool-bridge";
const FLAG = "claudeCliToolBridgeEnabled";
/**
 * What the switch changes today. Tools run in the Gateway's governed runner, and every tool step
 * is its own `claude -p` run, so the copy must not suggest Claude Code runs or isolates the tools.
 */
const BRIDGE_FACTS = [
  "Tools run in GoatCitadel, not inside Claude Code. Your permissions, tool grants and approvals still decide what may run.",
  "Each tool step is a separate claude -p run with your own Claude sign-in, so a turn that uses tools counts more against your Claude subscription.",
  "Tools are not sandboxed by this setting. It is a GoatCitadel option, not an Anthropic feature.",
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

export function ClaudeCliToolBridgeControl() {
  const query = useQuery({
    queryKey: ["system", "settings-claude-cli-tool-bridge"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: "features:system:claude-cli-tool-bridge",
    draftLabel: "Claude Code CLI tools",
    recovery: { path: "/settings/models", anchor: CLAUDE_CLI_TOOL_BRIDGE_ANCHOR },
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
      id={CLAUDE_CLI_TOOL_BRIDGE_ANCHOR}
      aria-labelledby="claude-cli-tool-bridge-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="claude-cli-tool-bridge-title" className="text-md font-semibold text-fg">
            Claude Code CLI: let it use GoatCitadel tools
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Experimental and off by default. When on, Chat turns on the Claude Code CLI provider can ask for GoatCitadel
            tools.
          </p>
        </div>
        <Button size="sm" disabled={settings.isFetching || governed.busy} onClick={governed.refresh}>
          Refresh
        </Button>
      </div>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading setting…"
        incomplete="Gateway did not report this setting. Refresh, or update the Gateway, before changing it."
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
              aria-describedby="claude-cli-tool-bridge-facts"
              disabled={governed.locked}
              onChange={(event) => {
                governed.clearNotice();
                draft.setValue(event.target.checked);
              }}
            />
            Let the Claude Code CLI use GoatCitadel tools
          </label>
          <ul id="claude-cli-tool-bridge-facts" className="mt-2 list-inside list-disc space-y-1 text-xs text-fg-muted">
            {BRIDGE_FACTS.map((fact) => (
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
        owner="claude-cli-tool-bridge"
        recoveryLabel="Inspect Claude Code CLI tool setting activity"
      />
    </section>
  );
}
