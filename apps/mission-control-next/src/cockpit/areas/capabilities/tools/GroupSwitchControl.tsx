import { useId } from "react";
import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { StatusBadge } from "../../../ui/StatusBadge";
import { Switch } from "../../../ui/Switch";
import { inboxApprovalLink } from "../capability-links";
import { useToolGroupSwitch } from "./use-tool-group-switch";

const ALWAYS_ON: StatusPresentation = { label: "Always on", tone: "done" };
const ON_NOTE = "Takes effect in new chats.";
const OFF_NOTE = "The AI can't use these in any chat.";
const WAITING = "Waiting on you in Inbox";

interface GroupSwitchControlProps {
  /** The live row from the cached list. */
  group: CapabilityToolGroupItem;
  /** The Settings revision the list was read at. */
  settingsRevision: number;
  /** The switch's accessible name. A group can show in two places at once, and each place needs its own. */
  switchLabel: string;
  /**
   * Whether the note under the switch and a failure are read out. A group shown twice announces in one place only,
   * so the second place passes false and still shows the same words.
   */
  announce?: boolean;
}

/** The link to the approval a change waits on, in the sentence that says so. */
function InboxLink({ approvalId, scope }: { approvalId: string; scope: string }) {
  const link = inboxApprovalLink(approvalId);
  return (
    <NativeOwnerLink scope={scope} href={link.href}>
      {link.label}
    </NativeOwnerLink>
  );
}

function LiveGroupSwitch({ group, settingsRevision, switchLabel, announce = true }: GroupSwitchControlProps) {
  const control = useToolGroupSwitch(group, settingsRevision);
  const noteId = useId();
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 text-left sm:items-end sm:text-right">
      <Switch
        checked={control.checked}
        onCheckedChange={control.setEnabled}
        label={switchLabel}
        // A change that waits in Inbox keeps its old state, and the switch ignores toggles until it lands.
        pending={control.pending || control.waiting}
        describedBy={noteId}
      />
      <div id={noteId} role={announce ? "status" : undefined} className="text-xs text-fg-secondary">
        {control.waiting ? (
          <p>
            <span className="font-medium text-fg">{WAITING}</span>
            {control.waitingApprovalId ? (
              <>
                {" "}
                <InboxLink approvalId={control.waitingApprovalId} scope={group.groupId} />
              </>
            ) : null}
          </p>
        ) : (
          <p>{group.state === "off" ? OFF_NOTE : ON_NOTE}</p>
        )}
      </div>
      {control.failure ? (
        <div role={announce ? "alert" : undefined} className="space-y-1 text-xs text-status-failed">
          <p>{control.failure.message}</p>
          {control.failure.conflict ? (
            <Button size="sm" variant="ghost" onClick={control.reload}>
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The on/off switch of a tool group and what stands under it: what the state means, a change that waits on an
 * approval in Inbox (with the link to it), or why the last change didn't happen. Core has no switch and reads
 * "Always on". Every view of a group reads the same switch state, so a wait shows on all of them.
 */
export function GroupSwitchControl(props: GroupSwitchControlProps) {
  if (props.group.state === "always_on") return <StatusBadge status={ALWAYS_ON} />;
  return <LiveGroupSwitch {...props} />;
}
