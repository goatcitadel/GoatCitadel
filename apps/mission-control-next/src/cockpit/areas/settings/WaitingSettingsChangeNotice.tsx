import { useEffect } from "react";
import {
  describeWaitingChange,
  type WaitingSettingsNotice,
  type WaitingSubject,
} from "../../../features/native-routes/settings/settings-save-outcome";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { reopenSettingsApproval, SettingsApprovalDialog } from "./SettingsApprovalDialog";

/**
 * Leads to an earlier change to this setting that is still open: its own approval opens in place (the existing
 * approval from the Gateway's conflict, never a new one), a change that needs the operator's review or an unreadable
 * one links to Inbox, and a change being applied has nothing to do yet.
 *
 * The sentence is a plain paragraph, not a live region (the cockpit's live-region budget only goes down). A control
 * that already announces its own notice passes `showSentence={false}`, puts `describeWaitingChange` in that notice
 * and renders only the action here.
 */
export function WaitingSettingsChangeNotice({
  waiting,
  onResolved,
  subject = "setting",
  showSentence = true,
  onCheckAgain,
  dangerReview,
  installationSetting,
}: {
  waiting: WaitingSettingsNotice;
  onResolved: () => void;
  /** What the change is to: the words that follow "this" in each sentence. */
  subject?: WaitingSubject;
  showSentence?: boolean;
  /** A control with no refresh of its own offers a "Check again" that looks at the waiting change once more. */
  onCheckAgain?: () => void;
  /** Keeps the two-step review for a danger-level approval, as the control's own save dialog does. */
  dangerReview?: boolean;
  /** The change is an install-wide Settings change, so it can be decided from any selected workspace. */
  installationSetting?: boolean;
}) {
  const approvalId = "unreadable" in waiting || waiting.stage !== "approval" ? undefined : waiting.approvalId;
  useEffect(() => {
    if (approvalId) reopenSettingsApproval(approvalId);
  }, [approvalId]);

  let action = null;
  if (approvalId)
    action = (
      <SettingsApprovalDialog
        approvalId={approvalId}
        {...(!("unreadable" in waiting) && waiting.title ? { title: waiting.title } : {})}
        reviewLabel="Review the waiting change"
        {...(dangerReview ? { dangerReview } : {})}
        {...(installationSetting ? { installationSetting } : {})}
        onResolved={onResolved}
      />
    );
  else if ("unreadable" in waiting || waiting.stage === "review")
    action = (
      <NativeOwnerLink href="/inbox?workspaceId=default" scope={waiting.planId}>
        {"unreadable" in waiting ? "Open Inbox to approve it." : "Open Inbox to review it."}
      </NativeOwnerLink>
    );
  if (!showSentence && !action && !onCheckAgain) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-status-waiting">
      {showSentence ? <p>{describeWaitingChange(waiting, subject)}</p> : null}
      {action}
      {onCheckAgain ? (
        <Button size="sm" onClick={onCheckAgain}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
