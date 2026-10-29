import { useId, useRef } from "react";
import type { CapabilitySkillItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Switch } from "../../../ui/Switch";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { CANT_SWITCH_NOTE, PINNED_NOTE, presentSkillChange, type SkillStatePresentation } from "./skill-view";
import type { SkillSwitch } from "./use-skill-switch";

const ON_NOTE = "Takes effect in new chats.";
// Chat always loads a paused skill it's asked for by name. It picks one for a close match on its own only when the
// activation policy doesn't ask before a paused skill's first use (`chat-skill-selection-runtime.ts`).
const PAUSED_NOTE =
  "Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.";

/**
 * The approval the change waits on, decided here: it opens on its own once, and "Review the change" opens it again.
 * Skill approvals belong to no workspace, so the Inbox (which lists a workspace's approvals) never shows them, and
 * nothing here points there. A decline publishes no skill event, so the switch is asked to read the approval at once
 * rather than at its next check.
 */
function ApprovalInPlace({ item, sw, approvalId }: { item: CapabilitySkillItem; sw: SkillSwitch; approvalId: string }) {
  return (
    <SettingsApprovalDialog
      approvalId={approvalId}
      workspaceId={null}
      title="Approve this skill change?"
      // Only names the change for the operator, under the approval's own title; the review says what it applies.
      summary={presentSkillChange(item.name, sw.waitingTarget, item.state)}
      reviewLabel="Review the change"
      loadFailureHint="Reload to try again."
      onResolved={() => sw.checkApproval()}
    />
  );
}

/**
 * The panel's switch, named "Turn it on or off: <name>" so it never shares a name with the skill's row. The state word
 * stands once, in the badge at the top of the panel, so the switch prints none beside itself. Under it: why the change
 * waits, or what the state means; the approval in place with "Review the change"; why the last change didn't happen;
 * and Pause or Resume.
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
        {/* The notes say what On and Paused do, so only a skill the AI can use here takes one; the reason line under
            the badge already says why any other skill can't be used. */}
        {state.kind === "waiting" ? (
          <p className="font-medium text-fg">{state.reason}</p>
        ) : state.kind === "on" ? (
          <p>{ON_NOTE}</p>
        ) : state.kind === "paused" ? (
          <p>{PAUSED_NOTE}</p>
        ) : null}
        {item.pinned ? <p>{PINNED_NOTE}</p> : null}
      </div>
      {sw.waitingApprovalId ? (
        <ApprovalInPlace key={sw.waitingApprovalId} item={item} sw={sw} approvalId={sw.waitingApprovalId} />
      ) : null}
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
      {!item.pinned && item.state !== "off" ? (
        // Busy rather than disabled while a change is under way, so a keyboard operator keeps their place.
        <Button size="sm" loading={busy} onClick={() => sw.setPaused(item.state === "on")}>
          {item.state === "on" ? "Pause" : "Resume"}
        </Button>
      ) : null}
    </div>
  );
}
