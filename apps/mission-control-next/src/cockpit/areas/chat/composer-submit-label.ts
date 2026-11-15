import { channelReplySubmitLabel } from "./channel-composer";
import type { ComposerProps } from "./ChatTextComposer.types";

/** What the composer's send button says, from the state of the turn and of a local command in the box. */
export function composerSubmitLabel(
  props: Pick<ComposerProps, "hasActiveStream" | "midTurnDisposition" | "sending" | "editingTurnId" | "channelReply">,
  local: { ready: boolean; command: string },
): string {
  if (props.hasActiveStream) return props.midTurnDisposition === "steer" ? "Steer response" : "Queue message";
  if (local.ready) {
    if (local.command === "/schedule") return "Open schedules";
    return local.command === "/timer" ? "Open timer" : "Show status";
  }
  if (props.sending) return "Sending…";
  return props.editingTurnId ? "Send edited message" : channelReplySubmitLabel(props.channelReply);
}
