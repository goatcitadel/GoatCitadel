import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

/** The jump button's name: a decision waiting for you comes first, then the count of new messages. */
export function jumpLabel(
  props: Pick<MissionThreadedActiveSessionSurfaceProps, "pendingApproval" | "pendingUserInput">,
  unread: number,
): string {
  if (props.pendingApproval) return "Jump to the approval waiting for you";
  if (props.pendingUserInput) return "Jump to the question waiting for you";
  return `Jump to latest${unread ? ` · ${plural(unread, "new message")}` : ""}`;
}

/** After the jump the button is gone: focus the decision waiting for you when its card is shown, else the composer. */
export function focusAfterJump(composer: HTMLElement | null, scroller: HTMLElement | null): void {
  const waiting = document.querySelector<HTMLElement>("[data-chat-waiting-decision]");
  if (waiting) {
    waiting.focus({ preventScroll: false });
    return;
  }
  if (composer && !(composer as HTMLTextAreaElement).disabled) composer.focus({ preventScroll: true });
  else scroller?.focus({ preventScroll: true });
}
