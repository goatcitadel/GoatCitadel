import { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { resolveChatRouteReadiness } from "../../../features/threaded-surface/chat-route-readiness";
import {
  channelCheckBlock,
  channelFilesBlock,
  channelReplyBlock,
  type ChannelCheck,
  type ChannelCheckBlock,
  type ChannelReply,
  type ChannelReplyBlock,
} from "./channel-composer";

type SendBlockProps = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "draft"
  | "canSend"
  | "historicalReadOnly"
  | "sessionControlBanner"
  | "pendingApproval"
  | "pendingUserInput"
  | "pendingAttachments"
  | "runVariablePanel"
  | "composerPalette"
  | "routeBoundaryAckRequired"
  | "routeBoundaryAcknowledged"
  | "selectedSessionId"
  | "profileDependentAdmissionBlockReason"
  | "routePreflight"
  | "routePreflightError"
  | "routePreflightLoading"
  | "providerOptions"
  | "selectedProviderId"
  | "selectedModel"
  | "commandSuggestions"
> & { channelReply?: ChannelReply; channelCheck?: ChannelCheck };

/**
 * Why the composer will not send right now. `route-checking` is the only transient kind:
 * an explicit send may still start, because the controller runs its own fresh preflight
 * before dispatch. A channel conversation adds `channel-removed`, `channel-off` and `reply-window-closed` (WhatsApp's
 * 24 hours), and one whose channel is not known yet adds `channel-checking` and `channel-unavailable`; none of these
 * sends.
 */
export type ComposerSendBlock =
  | { kind: "route-checking"; message: string }
  | { kind: "historical"; message: string }
  | { kind: "blocked"; message: string }
  | ChannelReplyBlock
  | ChannelCheckBlock;

export const ROUTE_CHECKING_MESSAGE = "Checking the selected model… Send waits until the check finishes.";

/**
 * A slash command is committed once its first token (`/word`, followed by whitespace or the end of the
 * draft) exactly equals a listed suggestion's apply value. The palette trigger keeps a complete command's
 * suggestion open, so without this rule Enter would re-apply the same command forever instead of sending.
 * Context (`@`) and skill (`$`) tokens are never committed this way; applying them clears their trigger.
 */
export function committedCommandDraft(
  draft: string,
  suggestions: readonly Pick<SendBlockProps["commandSuggestions"][number], "applyValue">[],
): boolean {
  const token = /^\s*(\/\S+)(?=\s|$)/u.exec(draft)?.[1];
  if (!token) return false;
  return suggestions.some((suggestion) => suggestion.applyValue.trim() === token);
}

export function composerSendBlock(props: SendBlockProps): ComposerSendBlock | null {
  if (props.historicalReadOnly)
    return {
      kind: "historical",
      message:
        "This is an earlier version of the conversation, so it is read-only. Go back to the latest version to reply.",
    };
  if (props.sessionControlBanner)
    return {
      kind: "blocked",
      message: `Sending is paused while another client (${props.sessionControlBanner.model.ownerLabel}) controls this conversation.`,
    };
  const channelBlock =
    channelCheckBlock(props.channelCheck) ??
    channelReplyBlock(props.channelReply) ??
    channelFilesBlock(props.channelReply, props.pendingAttachments.length);
  if (channelBlock) return channelBlock;
  if (props.pendingApproval || (props.pendingUserInput && !isBackgroundChatUserInputPrompt(props.pendingUserInput)))
    return { kind: "blocked", message: "A decision is waiting above. Resolve it to keep going." };
  if (props.runVariablePanel?.open)
    return { kind: "blocked", message: "Apply or close the run variables before sending." };
  if (props.composerPalette?.globalOpen)
    return { kind: "blocked", message: "Choose an item in Commands and context, or close it, before sending." };
  if (props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged)
    return { kind: "blocked", message: "Acknowledge the route fallback before sending." };
  if (
    props.commandSuggestions.length &&
    /^\s*[/@$]/.test(props.draft) &&
    !committedCommandDraft(props.draft, props.commandSuggestions)
  )
    return { kind: "blocked", message: "Choose a suggestion before sending." };
  if (!props.canSend && (props.draft.trim() || props.pendingAttachments.length)) {
    if (props.profileDependentAdmissionBlockReason)
      return { kind: "blocked", message: props.profileDependentAdmissionBlockReason };
    if (props.selectedSessionId && props.routePreflightLoading && !props.routePreflight && !props.routePreflightError)
      return { kind: "route-checking", message: ROUTE_CHECKING_MESSAGE };
    return {
      kind: "blocked",
      message:
        resolveChatRouteReadiness(props).sendHint ??
        "Sending is unavailable right now. Check the provider and model above.",
    };
  }
  return null;
}
