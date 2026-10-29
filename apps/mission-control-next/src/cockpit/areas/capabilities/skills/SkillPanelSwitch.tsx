import { useId, useRef } from "react";
import type { CapabilitySkillItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Switch } from "../../../ui/Switch";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { CANT_SWITCH_NOTE, PINNED_NOTE, type SkillStatePresentation } from "./skill-view";
import type { SkillSwitch } from "./use-skill-switch";

const ON_NOTE = "Takes effect in new chats.";
const PAUSED_NOTE = "Paused skills are used only when you name them in Chat.";

/** What stands under the switch while it waits: why, with the way to the approval in Inbox beside it. */
function WaitingLine({ item, state }: { item: CapabilitySkillItem; state: SkillStatePresentation }) {
  return (
    <p>
      <span className="font-medium text-fg">{state.reason}</span>
      {state.link ? (
        <>
          {" "}
          <NativeOwnerLink scope={item.skillId} href={state.link.href}>
            {state.link.label}
          </NativeOwnerLink>
        </>
      ) : null}
    </p>
  );
}

/**
 * The panel's switch, named "Turn it on or off: <name>" so it never shares a name with the skill's row. The state word
 * stands once, in the badge at the top of the panel, so the switch prints none beside itself. Under it: the waiting
 * line (with "Open in Inbox"), or what the state means; why the last change didn't happen; Pause or Resume; and the
 * approval in place, which opens once for each approval the change waits on.
 *
 * Beside the page the skill's row reads the wait and a failure out, so the panel stays quiet; a modal inspector hides
 * the page, so there (`announce`) the panel reads them out itself.
 */
export function SkillPanelSwitch({
  item,
  sw,
  state,
  announce,
}: {
  item: CapabilitySkillItem;
  sw: SkillSwitch;
  state: SkillStatePresentation;
  announce: boolean;
}) {
  const noteId = useId();
  // A failure the store kept from before the panel opened was read out when it happened (see SkillRow).
  const mountedWith = useRef(sw.failure);
  if (!item.switchable) return <p className="text-sm text-fg-secondary">{CANT_SWITCH_NOTE}</p>;
  const busy = sw.pending || sw.waiting;
  const announceFailure = announce && sw.failure !== mountedWith.current;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg">Turn it on or off</span>
        <Switch
          checked={sw.checked}
          onCheckedChange={sw.setOn}
          label={`Turn it on or off: ${item.name}`}
          onText=""
          offText=""
          pending={busy}
          disabled={item.pinned}
          describedBy={noteId}
        />
      </div>
      <div id={noteId} role={announce ? "status" : undefined} className="space-y-1 text-xs text-fg-secondary">
        {sw.waiting ? (
          <WaitingLine item={item} state={state} />
        ) : item.state === "on" ? (
          <p>{ON_NOTE}</p>
        ) : item.state === "paused" ? (
          <p>{PAUSED_NOTE}</p>
        ) : null}
        {item.pinned ? <p>{PINNED_NOTE}</p> : null}
      </div>
      {sw.failure ? (
        <div role={announceFailure ? "alert" : undefined} className="space-y-1 text-sm text-status-failed">
          <p>{sw.failure.message}</p>
          {sw.failure.conflict ? (
            <Button size="sm" variant="ghost" onClick={sw.reload}>
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
      {sw.waitingApprovalId ? (
        // Skill approvals belong to no workspace. A decision here publishes no skill event when it declines, so the
        // switch is asked to read the approval at once rather than at its next check.
        <SettingsApprovalDialog
          key={sw.waitingApprovalId}
          approvalId={sw.waitingApprovalId}
          workspaceId={null}
          title="Approve this skill change?"
          loadFailureHint="Decide it in Inbox."
          onResolved={() => sw.checkApproval()}
        />
      ) : null}
      {!item.pinned && item.state !== "off" ? (
        // Busy rather than disabled while a change is under way, so a keyboard operator keeps their place.
        <Button size="sm" loading={busy} onClick={() => sw.setPaused(item.state === "on")}>
          {item.state === "on" ? "Pause" : "Resume"}
        </Button>
      ) : null}
    </div>
  );
}
