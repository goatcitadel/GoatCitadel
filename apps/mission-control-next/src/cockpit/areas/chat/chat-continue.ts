import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { composerSendBlock } from "./composer-send-block";

/** The follow-up Continue sends. It is an ordinary user message, so the usual governance applies. */
export const CONTINUE_MESSAGE = "Continue from where you stopped.";

export type ContinueProps = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "draft"
  | "canSend"
  | "sending"
  | "hasActiveStream"
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
 * Continue is offered only on the latest turn, when the user stopped it and it kept some text, nothing is running,
 * the composer is empty (so no draft is replaced) and the composer would accept a send right now.
 */
export function canContinueTurn(turn: ChatThreadTurnRecord, isLatest: boolean, props: ContinueProps): boolean {
  if (!isLatest || turn.trace.status !== "cancelled" || !turn.assistantMessage?.content?.trim()) return false;
  if (props.sending || props.hasActiveStream) return false;
  if (props.draft?.trim() || props.pendingAttachments?.length) return false;
  return composerSendBlock(withComposerDefaults(props, true)) === null;
}

/** Once the continuation sits in the composer: send, wait for the route check, or leave it there for the user. */
export function continueSendDecision(props: ContinueProps): "send" | "leave" {
  const block = composerSendBlock(withComposerDefaults(props, props.canSend));
  return block === null || block.kind === "route-checking" ? "send" : "leave";
}

function withComposerDefaults(props: ContinueProps, canSend: boolean) {
  return {
    ...props,
    draft: CONTINUE_MESSAGE,
    canSend,
    pendingAttachments: props.pendingAttachments ?? [],
    commandSuggestions: props.commandSuggestions ?? [],
  };
}
