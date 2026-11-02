import { useQuery } from "@tanstack/react-query";
import type { ChangePlanRecord, ChatMessagingOverview } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { useMessagingOverview } from "../chat/use-messaging-overview";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";

export const BROWSER_ERRAND_APPROVALS_ANCHOR = "browser-errand-approvals";
const OPERATION = "browser_errand_approval_conversation";
const HELP =
  "When you're away from the PC, errand approvals go here and to your phone if you haven't answered in 30 seconds.";
const NOT_LISTED = "A conversation not listed here";

export interface ErrandApprovalConversationOption {
  sessionId: string;
  label: string;
}

/** The operator's own private conversations, as `<channel label> · <title>`, in the order Messaging lists them. */
export function errandApprovalConversationOptions(
  overview: ChatMessagingOverview | undefined,
): ErrandApprovalConversationOption[] {
  return (overview?.channels ?? []).flatMap((channel) =>
    channel.conversations
      .filter((conversation) => conversation.own && conversation.kind === "direct")
      .map((conversation) => ({
        sessionId: conversation.sessionId,
        label: `${channel.label} · ${conversation.title}`,
      })),
  );
}

/** The saved pick; no conversation is the empty string. `undefined` when GoatCitadel does not report the setting. */
const readPick = (settings: RuntimeSettingsResponse): string | undefined =>
  settings.browserErrands ? (settings.browserErrands.approvalSessionId ?? "") : undefined;

/** Only a plan for this exact pick, or for clearing it, settles this draft. */
const matchesPlan = (plan: ChangePlanRecord, submitted: string) =>
  plan.kind === "runtime_configuration" &&
  plan.request.kind === "runtime_configuration" &&
  plan.request.change.operation === OPERATION &&
  plan.target.ownerId === "runtime_settings" &&
  (plan.request.change.config.approvalSessionId ?? "") === submitted.trim();

/**
 * Where waiting browser errand approvals go: one of the operator's own private channel conversations, or none. A save
 * is a Settings change approved in place, like the switch above it, and GoatCitadel refuses any conversation that is
 * not the operator's own.
 */
export function BrowserErrandsApprovalConversationField({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["system", "settings-browser-errands"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const overview = useMessagingOverview(workspaceId);
  const governed = useGovernedRuntimeSetting<string>({
    settings: query,
    draftKey: "browser-errands:system:approval-conversation",
    draftLabel: "Where errand approvals go",
    recovery: { path: "/settings/tools", anchor: BROWSER_ERRAND_APPROVALS_ANCHOR },
    read: readPick,
    fallback: "",
    patch: (value) => ({ browserErrandApprovalSessionId: value.trim() || null }),
    operation: OPERATION,
    matchesPlan,
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current conversation, then apply your draft again.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Conversation saved.",
    },
  });
  const { ready, current, draft } = governed;
  const options = errandApprovalConversationOptions(overview.data);
  const labelFor = (sessionId: string) =>
    sessionId ? (options.find((option) => option.sessionId === sessionId)?.label ?? NOT_LISTED) : "None";
  // A saved or drafted pick missing from the list (another workspace, or a conversation since removed) stays selectable.
  const unlisted = [current, draft.value].filter(
    (sessionId, index, all) =>
      sessionId && all.indexOf(sessionId) === index && !options.some((option) => option.sessionId === sessionId),
  );

  return (
    <div id={BROWSER_ERRAND_APPROVALS_ANCHOR} className="mt-4 max-w-xl space-y-3">
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading where errand approvals go…"
        incomplete="GoatCitadel did not report where errand approvals go. Update GoatCitadel before changing it."
      />
      {ready ? (
        <>
          <Field label="Where errand approvals go" help={HELP}>
            {(props) => (
              <select
                {...props}
                className={cockpitInputClass}
                value={draft.value}
                disabled={governed.locked}
                onChange={(event) => {
                  governed.clearNotice();
                  draft.setValue(event.target.value);
                }}
              >
                <option value="">None</option>
                {options.map((option) => (
                  <option key={option.sessionId} value={option.sessionId}>
                    {option.label}
                  </option>
                ))}
                {unlisted.map((sessionId) => (
                  <option key={sessionId} value={sessionId}>
                    {NOT_LISTED}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {overview.isSuccess && options.length === 0 ? (
            <p className="text-xs text-fg-muted">
              No private conversation of yours is listed yet. Message GoatCitadel from your own account on a channel,
              then choose “This is you” for that account in the channel’s people list.
            </p>
          ) : null}
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${labelFor(draft.value)}`}
            currentLabel={labelFor(current)}
          />
          <Button variant="primary" disabled={!governed.canSave} onClick={() => void governed.save()}>
            {governed.busy ? "Saving…" : "Save conversation"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="browser-errand-approvals"
        recoveryLabel="Inspect errand approval conversation activity"
      />
    </div>
  );
}
