import { useRef, type ReactNode } from "react";
import type { CapabilityToolGroupItem } from "@goatcitadel/contracts";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { StatusBadge } from "../../../ui/StatusBadge";
import { Switch } from "../../../ui/Switch";
import { inboxApprovalLink } from "../capability-links";
import { presentToolGroupState } from "./tool-view";
import { useToolGroupSwitch, type ToolGroupSwitch } from "./use-tool-group-switch";

const ALWAYS_ON = presentToolGroupState("always_on");
const ON_NOTE = "Takes effect in new chats.";
const OFF_NOTE = "The AI can't use these in any chat.";
const WAITING = "Waiting on you in Inbox";

// A group's switch comes in three pieces so a row can lay them out where they fit: the switch itself is small and
// stays beside the name, while the lines about it are sentences and run the width of the card, where they wrap. All
// three read one `ToolGroupSwitch`, which `GroupSwitchState` reads once.

function SwitchState({
  group,
  settingsRevision,
  children,
}: {
  group: CapabilityToolGroupItem;
  settingsRevision: number;
  children: (control: ToolGroupSwitch | undefined) => ReactNode;
}) {
  const control = useToolGroupSwitch(group, settingsRevision);
  return <>{children(control)}</>;
}

/**
 * Reads the on/off switch of a group and gives it to `children`. Core can't be switched, so it gets `undefined` and
 * never reads one. Every view of a group (a Most used card, its row, the open panel) reads the same switch state, so a
 * save, a wait in Inbox or a failure shows on all of them. `group` should be the live row from the cached list.
 */
export function GroupSwitchState({
  group,
  settingsRevision,
  children,
}: {
  group: CapabilityToolGroupItem;
  /** The Settings revision the list was read at. */
  settingsRevision: number;
  children: (control: ToolGroupSwitch | undefined) => ReactNode;
}) {
  if (group.state === "always_on") return <>{children(undefined)}</>;
  return (
    <SwitchState group={group} settingsRevision={settingsRevision}>
      {children}
    </SwitchState>
  );
}

/** The on/off switch, or "Always on" for Core. A group that waits in Inbox keeps its old state and ignores toggles. */
export function GroupSwitch({
  control,
  label,
  describedBy,
}: {
  control: ToolGroupSwitch | undefined;
  /** The switch's accessible name. A group can show in two places at once, and each place needs its own. */
  label: string;
  /** The id of `GroupSwitchNotes`, which says what the switch means. */
  describedBy: string;
}) {
  if (!control) return <StatusBadge status={ALWAYS_ON} />;
  return (
    <Switch
      checked={control.checked}
      onCheckedChange={control.setEnabled}
      label={label}
      pending={control.pending || control.waiting}
      describedBy={describedBy}
    />
  );
}

/** The link to the approval a change waits on, in the sentence that says so. */
function OpenInInboxLink({ approvalId, scope }: { approvalId: string; scope: string }) {
  const link = inboxApprovalLink(approvalId);
  return (
    <NativeOwnerLink scope={scope} href={link.href}>
      {link.label}
    </NativeOwnerLink>
  );
}

/**
 * What stands under a switch: what the state means, or that the change waits on an approval in Inbox (with the link
 * to it), and why the last change didn't happen. These are full sentences, so they belong in a block that can take
 * the card's width, never in a column that holds a switch.
 */
export function GroupSwitchNotes({
  group,
  control,
  id,
  announce = true,
  className,
}: {
  group: CapabilityToolGroupItem;
  control: ToolGroupSwitch | undefined;
  /** Names the note, for the switch's description. */
  id: string;
  /**
   * Whether the note and a failure are read out. A group shown twice announces in one place only, so the second place
   * passes false and still shows the same words.
   */
  announce?: boolean;
  className?: string;
}) {
  // The store keeps a failure for the whole app session, so one can already stand when this view mounts (the tab
  // comes back, or a modal panel opens). It was read out when it happened; only a failure that is new to this view
  // is announced. A new failure is a different object, even with the same words.
  const mountedWith = useRef(control?.failure);
  if (!control) return null;
  const announceFailure = announce && control.failure !== mountedWith.current;
  return (
    <div className={cn("space-y-1 text-xs text-fg-secondary", className)}>
      <div id={id} role={announce ? "status" : undefined}>
        {control.waiting ? (
          <p>
            <span className="font-medium text-fg">{WAITING}</span>
            {control.waitingApprovalId ? (
              <>
                {" "}
                <OpenInInboxLink approvalId={control.waitingApprovalId} scope={group.groupId} />
              </>
            ) : null}
          </p>
        ) : (
          <p>{group.state === "off" ? OFF_NOTE : ON_NOTE}</p>
        )}
      </div>
      {control.failure ? (
        <div role={announceFailure ? "alert" : undefined} className="space-y-1 text-status-failed">
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
