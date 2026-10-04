import { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { resolveChatRouteReadiness } from "../../../features/threaded-surface/chat-route-readiness";

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
>;

/**
 * Why the composer will not send right now. `route-checking` is the only transient kind:
 * an explicit send may still start, because the controller runs its own fresh preflight
 * before dispatch.
 */
export type ComposerSendBlock =
  | { kind: "route-checking"; message: string }
  | { kind: "historical"; message: string }
  | { kind: "blocked"; message: string };

export const ROUTE_CHECKING_MESSAGE = "Checking the chat route. Send will wait for the Gateway check.";

export function composerSendBlock(props: SendBlockProps): ComposerSendBlock | null {
  if (props.historicalReadOnly)
    return {
      kind: "historical",
      message: "This is an earlier version of the conversation, so it is read-only. Go back to the latest version to reply.",
    };
  if (props.sessionControlBanner)
    return {
      kind: "blocked",
      message: `Sending is paused while another client (${props.sessionControlBanner.model.ownerLabel}) controls this conversation.`,
    };
  if (props.pendingApproval || (props.pendingUserInput && !isBackgroundChatUserInputPrompt(props.pendingUserInput)))
    return { kind: "blocked", message: "A decision is waiting above. Resolve it to keep going." };
  if (props.runVariablePanel?.open) return { kind: "blocked", message: "Apply or close the run variables before sending." };
  if (props.composerPalette?.globalOpen) return { kind: "blocked", message: "Choose a palette item before sending." };
  if (props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged)
    return { kind: "blocked", message: "Acknowledge the route fallback before sending." };
  if (getWorkflowSkillCaptureDisplay(props.draft))
    return {
      kind: "blocked",
      message: "This captured workflow needs review before it can be sent. Review it in the classic view.",
    };
  if (props.commandSuggestions.length && /^\s*[/@$]/.test(props.draft))
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
        "Sending is unavailable right now. Check the provider and model above, or open the classic view for details.",
    };
  }
  return null;
}
