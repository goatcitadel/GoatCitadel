import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { useEffect, useState } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { CONTINUE_MESSAGE, canContinueTurn, continueSendDecision } from "./chat-continue";

/**
 * "Continue" under a reply the user stopped. It puts the continuation in the composer and sends it through the normal
 * send handler once the composer holds it, so blocked states and approvals apply exactly as for a typed message.
 */
export function ChatContinueAction({
  turn,
  isLatest,
  actions,
}: {
  turn: ChatThreadTurnRecord;
  isLatest: boolean;
  actions: MissionThreadedActiveSessionSurfaceProps;
}) {
  const [pending, setPending] = useState(false);
  const holdsMessage = actions.draft === CONTINUE_MESSAGE;
  useEffect(() => {
    if (!pending || !holdsMessage) return;
    setPending(false);
    if (continueSendDecision(actions) === "send") actions.onSend();
  }, [pending, holdsMessage, actions]);
  if (!pending && !canContinueTurn(turn, isLatest, actions)) return null;
  return (
    <Button
      size="sm"
      className="mt-2 h-8 max-sm:h-11"
      onClick={() => {
        setPending(true);
        actions.onDraftChange(CONTINUE_MESSAGE);
      }}
    >
      Continue
    </Button>
  );
}
