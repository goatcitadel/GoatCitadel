import { useEffect } from "react";
import type { WaitingSettingsChange } from "../../../features/native-routes/settings/settings-save-outcome";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { reopenSettingsApproval, SettingsApprovalDialog } from "./SettingsApprovalDialog";

/** A waiting change as the save hooks hold it: read, or named by the Gateway but not readable right now. */
export type WaitingSettingsNotice = WaitingSettingsChange | { planId: string; unreadable: true };

function isUnreadable(waiting: WaitingSettingsNotice): waiting is { planId: string; unreadable: true } {
  return "unreadable" in waiting;
}

/**
 * Says an earlier change to this setting is still open and leads to it: its own approval opens in place (the
 * existing approval from the Gateway's conflict, never a new one), or Inbox when it cannot be read. The sentences are
 * plain paragraphs, not live regions: the cockpit's live-region budget only goes down.
 */
export function WaitingSettingsChangeNotice({
  waiting,
  onResolved,
  subject = "setting",
}: {
  waiting: WaitingSettingsNotice;
  onResolved: () => void;
  /** What the change is to: the words that follow "this" in each sentence. */
  subject?: "setting" | "rule";
}) {
  const approvalId = isUnreadable(waiting) ? undefined : waiting.approvalId;
  useEffect(() => {
    if (approvalId) reopenSettingsApproval(approvalId);
  }, [approvalId]);

  if (isUnreadable(waiting))
    return (
      <p className="mt-3 text-sm text-status-waiting">
        One change to this {subject} is already waiting.{" "}
        <NativeOwnerLink href="/inbox?workspaceId=default" scope={waiting.planId}>
          Open Inbox
        </NativeOwnerLink>{" "}
        to approve it.
      </p>
    );
  if (approvalId)
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-status-waiting">
        <p>One change to this {subject} is already waiting for your approval.</p>
        <SettingsApprovalDialog
          approvalId={approvalId}
          {...(waiting.title ? { title: waiting.title } : {})}
          reviewLabel="Review the waiting change"
          onResolved={onResolved}
        />
      </div>
    );
  return (
    <p className="mt-3 text-sm text-status-waiting">
      One change to this {subject} is still being applied. Refresh in a moment to see it.
    </p>
  );
}
