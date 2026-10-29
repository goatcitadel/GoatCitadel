import { useId, useRef } from "react";
import { SKILL_ORIGIN_LABELS, type CapabilitySkillItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { StatusBadge } from "../../../ui/StatusBadge";
import { Switch } from "../../../ui/Switch";
import { LetterIcon } from "../LetterIcon";
import { CANT_SWITCH_NOTE, PINNED_NOTE, presentSkillState } from "./skill-view";
import { useSkillSwitch } from "./use-skill-switch";

/** Read out when a change starts waiting on its approval. The visible words stay in the row's own line. */
const WAITING_ANNOUNCEMENT = "Waiting for your approval in Inbox.";

export interface SkillRowProps {
  /** The live row from the cached list. */
  item: CapabilitySkillItem;
  /** The uses line, already worded (`presentSkillUses`). */
  uses: string;
  /** Opens the skill's panel. */
  onView: (skillId: string) => void;
}

/**
 * One installed skill as a row card: its letter icon, name and origin, a one-line description, its switch and the line
 * that says why it reads as it does (or how often it was used). The button opens the skill's panel through `onView`;
 * the row itself is not a click target, because the switch sits inside it.
 *
 * The switch prints the state word beside itself, once: "On" only when the skill is on and the AI can use it here, and
 * otherwise Paused, Not usable yet, Left out of this workspace and the rest of `presentSkillState`. A skill whose switch
 * can't reach it has no switch to print the word, so a badge does. Every view of a skill reads one switch state
 * (`useSkillSwitch`), so a request, a wait in Inbox or a failure shows on all of them. `item` should be the live row
 * from the cached list.
 */
export function SkillRow({ item, uses, onView }: SkillRowProps) {
  const sw = useSkillSwitch(item);
  const state = presentSkillState(item, sw, uses);
  const noteId = useId();
  // The store keeps a failure for the whole app session, so one can already stand when this row mounts (the tab comes
  // back). It was read out when it happened; only a failure that is new to this row is announced. A new failure is a
  // different object, even with the same words.
  const mountedWith = useRef(sw.failure);
  const announceFailure = sw.failure !== mountedWith.current;
  return (
    <li className="min-w-0 rounded-lg border border-line-subtle bg-raised p-3">
      <div className="flex min-w-0 items-start gap-3">
        <LetterIcon name={item.name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-fg">{item.name}</h3>
            <span className="shrink-0 text-xs text-fg-muted">{SKILL_ORIGIN_LABELS[item.origin]}</span>
          </div>
          <p className="mt-0.5 truncate text-sm text-fg-secondary">{item.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {item.switchable ? (
              <Switch
                checked={sw.checked}
                onCheckedChange={sw.setOn}
                label={item.name}
                onText={state.label}
                offText={state.label}
                pending={sw.pending || sw.waiting}
                disabled={item.pinned}
                describedBy={noteId}
              />
            ) : (
              <>
                <StatusBadge status={state} />
                <span className="text-sm text-fg-secondary">{CANT_SWITCH_NOTE}</span>
              </>
            )}
          </div>
          <div id={noteId} className="mt-1 space-y-1 text-sm text-fg-secondary">
            {state.reason || state.link ? (
              <p>
                {state.reason}
                {state.link ? (
                  <>
                    {state.reason ? " " : null}
                    <NativeOwnerLink scope={item.skillId} href={state.link.href}>
                      {state.link.label}
                    </NativeOwnerLink>
                  </>
                ) : null}
              </p>
            ) : null}
            {item.switchable && item.pinned ? <p>{PINNED_NOTE}</p> : null}
          </div>
          {item.switchable ? (
            <p role="status" className="sr-only">
              {sw.waiting ? WAITING_ANNOUNCEMENT : ""}
            </p>
          ) : null}
          {sw.failure ? (
            <div role={announceFailure ? "alert" : undefined} className="mt-1 space-y-1 text-sm text-status-failed">
              <p>{sw.failure.message}</p>
              {sw.failure.conflict ? (
                <Button size="sm" variant="ghost" onClick={sw.reload}>
                  Reload
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* The name comes last so the accessible name starts with the visible word. */}
        <Button size="sm" aria-label={`View ${item.name}`} onClick={() => onView(item.skillId)}>
          View
        </Button>
      </div>
    </li>
  );
}
