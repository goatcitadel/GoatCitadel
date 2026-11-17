import { useId, useRef, type RefObject } from "react";
import type { CapabilitySkillItem, CapabilitySkillState } from "@goatcitadel/contracts";
import { skillStateApprovalEvidence } from "@goatcitadel/mission-control-shared/content/skill-state-approval-evidence";
import { Button } from "../../../ui/Button";
import { Switch } from "../../../ui/Switch";
import { FeatureOffLink } from "../../settings/FeatureOffLink";
import { useFeatureSwitchOn } from "../../settings/feature-switches";
import { SettingsApprovalDialog } from "../../settings/SettingsApprovalDialog";
import { CANT_SWITCH_NOTE, PINNED_NOTE, presentSkillChange, type SkillStatePresentation } from "./skill-view";
import type { SkillSwitch } from "./use-skill-switch";

const ON_NOTE = "Takes effect in new chats.";
/** Said under the On or Paused note while the Skills in Chat switch is off, because Chat then reads no skill. */
export const SKILLS_IN_CHAT_OFF_LINE = "Chat can't use skills yet: Skills in Chat is turned off.";
// Chat always loads a paused skill it's asked for by name. It picks one for a close match on its own only when the
// activation policy doesn't ask before a paused skill's first use (`chat-skill-selection-runtime.ts`).
const PAUSED_NOTE =
  "Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.";

function displayState(value: unknown): CapabilitySkillState | undefined {
  if (value === "enabled") return "on";
  if (value === "disabled") return "off";
  if (value === "sleep") return "paused";
  return undefined;
}

/**
 * Review the pending change next to the switch. A decline publishes no skill event, so check it here without waiting
 * for the next scheduled read.
 */
function ApprovalInPlace({
  item,
  sw,
  approvalId,
  switchButton,
}: {
  item: CapabilitySkillItem;
  sw: SkillSwitch;
  approvalId: string;
  switchButton: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <SettingsApprovalDialog
      approvalId={approvalId}
      workspaceId={null}
      title="Approve this skill change?"
      summary={(approval) => {
        const preview = approval.preview;
        if (preview?.skillId === item.skillId && skillStateApprovalEvidence(approval)) {
          return presentSkillChange(
            item.name,
            displayState(preview.state),
            displayState(preview.currentState) ?? item.state,
          );
        }
        return presentSkillChange(item.name, sw.waitingTarget, item.state);
      }}
      presentation="inline"
      loadFailureHint="Reload to try again."
      returnFocus={() => switchButton.current?.focus({ preventScroll: true })}
      onResolved={() => sw.checkApproval()}
    />
  );
}

/**
 * The panel's switch, named "Turn it on or off: <name>" so it never shares a name with the skill's row. The state word
 * stands once, in the badge at the top of the panel, so the switch prints none beside itself. Under it: why the change
 * waits, or what the state means; the inline approval; why the last change didn't happen;
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
  const skillsInChatOn = useFeatureSwitchOn("chatSkillInstructionsV1Enabled");
  const switchButton = useRef<HTMLButtonElement>(null);
  // A failure the store kept from before the panel opened was read out when it happened (see SkillRow).
  const mountedWith = useRef(sw.failure);
  if (!item.switchable) {
    // A skill removed with its plugin has nothing to switch, pause or resume: the reason under the badge says why.
    return item.removedWithPlugin ? null : <p className="text-sm text-fg-secondary">{CANT_SWITCH_NOTE}</p>;
  }
  const busy = sw.pending || sw.waiting;
  const announceFailure = announce && sw.failure !== mountedWith.current;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg">Turn it on or off</span>
        <Switch
          ref={switchButton}
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
        {skillsInChatOn === false && (state.kind === "on" || state.kind === "paused") ? (
          <p>
            {SKILLS_IN_CHAT_OFF_LINE} <FeatureOffLink flag="chatSkillInstructionsV1Enabled" />
          </p>
        ) : null}
        {item.pinned ? <p>{PINNED_NOTE}</p> : null}
      </div>
      {sw.waitingApprovalId ? (
        <ApprovalInPlace
          key={sw.waitingApprovalId}
          item={item}
          sw={sw}
          approvalId={sw.waitingApprovalId}
          switchButton={switchButton}
        />
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
