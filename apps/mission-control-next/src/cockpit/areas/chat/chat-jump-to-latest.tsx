import { createContext, useContext, useEffect } from "react";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

/** What the transcript is showing a card for: a decision that is waiting for you, or nothing. */
export type WaitingDecision = "approval" | "question" | null;

/** The transcript provides it; a decision card reports itself through it while it is rendered and waiting. */
export const WaitingDecisionContext = createContext<(kind: WaitingDecision) => void>(() => undefined);

export function useReportWaitingDecision(kind: WaitingDecision): void {
  const report = useContext(WaitingDecisionContext);
  useEffect(() => {
    report(kind);
    return () => report(null);
  }, [kind, report]);
}

/** The label names a decision only while its card is shown and waiting; the focus target comes from the same card. */
export function jumpLabel(waiting: WaitingDecision, unread: number): string {
  if (waiting === "approval") return "Jump to the approval waiting for you";
  if (waiting === "question") return "Jump to the question waiting for you";
  return `Jump to latest${unread ? ` · ${plural(unread, "new message")}` : ""}`;
}

/** After the jump the button is gone: focus the waiting decision's card in this transcript, else the composer. */
export function focusAfterJump(
  region: HTMLElement | null,
  composer: HTMLElement | null,
  scroller: HTMLElement | null,
  waiting: WaitingDecision,
): void {
  const card = waiting ? region?.querySelector<HTMLElement>("[data-chat-waiting-decision]") : null;
  if (card) {
    card.focus({ preventScroll: false });
    return;
  }
  if (composer && !(composer as HTMLTextAreaElement).disabled) composer.focus({ preventScroll: true });
  else scroller?.focus({ preventScroll: true });
}

/** The jump button. Moving focus afterwards is the transcript's job: this button unmounts when the jump follows output. */
export function JumpToLatestButton({
  waiting,
  unread,
  onJump,
}: {
  waiting: WaitingDecision;
  unread: number;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      className="absolute bottom-3 right-3 z-10 rounded-md border border-accent bg-overlay px-3 py-2 text-sm text-accent shadow-overlay"
    >
      {jumpLabel(waiting, unread)}
    </button>
  );
}
