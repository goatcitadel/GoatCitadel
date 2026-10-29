import { useQuery } from "@tanstack/react-query";
import { CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";

export const CHAT_THINKING_STREAM_ANCHOR = "chat-thinking-stream";
const FLAG = "chatThinkingStreamV1Enabled";
/** What turning it on does and does not do, as the Gateway and Chat behave today. */
const THINKING_FACTS = [
  "Reasoning is the model's own unreviewed text. It is not an explanation you can check the answer against.",
  "Only models that report their reasoning send any. With others, nothing changes.",
  "Reasoning is kept in this browser only, so it is gone after a page reload.",
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

export function ChatThinkingStreamControl() {
  const query = useQuery({
    queryKey: ["system", "settings-chat-thinking-stream"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: "features:system:chat-thinking-stream",
    draftLabel: "Model reasoning in Chat",
    recovery: { path: "/settings/models", anchor: CHAT_THINKING_STREAM_ANCHOR },
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
      id={CHAT_THINKING_STREAM_ANCHOR}
      aria-labelledby="chat-thinking-stream-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="chat-thinking-stream-title" className="text-md font-semibold text-fg">
            {CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[FLAG]?.label}
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Off by default. When on, a model's reasoning streams into Chat above its answer under “Thinking…”. While the
            model thinks, its newest line shows next to that label; the full text stays shut unless you open it.
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
          <div className="mt-3 flex items-center gap-3 text-sm text-fg-secondary">
            <Switch
              checked={draft.value}
              onCheckedChange={(next) => {
                governed.clearNotice();
                draft.setValue(next);
              }}
              label="Show model reasoning in Chat"
              disabled={governed.locked && !governed.busy}
              pending={governed.busy}
              describedBy="chat-thinking-stream-facts"
            />
            {/* The switch is named by its label; this is the same words for sighted operators. */}
            <span aria-hidden="true">Show model reasoning in Chat</span>
          </div>
          <ul id="chat-thinking-stream-facts" className="mt-2 list-inside list-disc space-y-1 text-xs text-fg-muted">
            {THINKING_FACTS.map((fact) => (
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
        owner="chat-thinking-stream"
        recoveryLabel="Inspect model reasoning setting activity"
      />
    </section>
  );
}
