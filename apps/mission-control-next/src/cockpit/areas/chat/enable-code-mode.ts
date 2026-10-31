import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { approvePlanInPlace } from "./channel-setup/approve-plan-in-place";

/** Settings changes are planned in the installation workspace. */
const SETTINGS_WORKSPACE = "default";
// The Inbox links channel setup uses (channel-hosts.ts), kept here so the card does not load Settings code.
const inboxApprovalHref = (approvalId: string) =>
  `/inbox?${new URLSearchParams({ approvalId, workspaceId: SETTINGS_WORKSPACE })}`;
const inboxPlanHref = (planId: string) =>
  `/inbox?${new URLSearchParams({ item: `change_plan:${planId}`, workspaceId: SETTINGS_WORKSPACE })}`;
const NEEDS_INBOX = "Turning on Code Mode needs one more step in Inbox. Finish it there, then run the code.";
const TURNING_ON = "Turning on Code Mode…";
/** A governed Settings change carries one flag, so Code Mode and its sandbox are turned on one after the other. */
const CODE_MODE_FLAGS = ["codeModeV1Enabled", "codeModeHostSandboxEnabled"] as const;

/**
 * Turning Code Mode on stopped at a step this click can't take (an approval this sign-in can't give, a change that
 * waits on more than an approval). `href` and `linkLabel` open that step in Inbox, beside the message.
 */
export class CodeModeStepInInbox extends Error {
  constructor(
    readonly href: string,
    readonly linkLabel: string,
  ) {
    super(NEEDS_INBOX);
    this.name = "CodeModeStepInInbox";
  }
}

/**
 * Turns Code Mode and its sandbox on through the governed Settings change, one flag at a time, and settles each
 * change's own approval in the same click. `progress` hears once that something is being turned on. Throws a
 * plain-words error when a change cannot finish here, so nothing else is approved.
 */
export async function enableCodeMode(progress?: (message: string) => void): Promise<void> {
  let reported = false;
  for (const flag of CODE_MODE_FLAGS) {
    const current = await fetchSettings();
    if (current.features[flag] === true) continue;
    if (!reported) progress?.(TURNING_ON);
    reported = true;
    const response = await patchSettings({ expectedRevision: current.revision, features: { [flag]: true } });
    const receipt = response.changePlanReceipt;
    if (!receipt || receipt.status === "completed" || receipt.status === "applied") continue;
    const outcome = await approvePlanInPlace(receipt.planId, SETTINGS_WORKSPACE);
    if (outcome.kind === "completed") continue;
    if (outcome.kind === "failed") throw new Error(outcome.message);
    throw outcome.approvalId
      ? new CodeModeStepInInbox(inboxApprovalHref(outcome.approvalId), "Approve it in Inbox")
      : new CodeModeStepInInbox(inboxPlanHref(outcome.plan.planId), "Review it in Inbox");
  }
}
