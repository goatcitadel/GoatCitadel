export {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  groupDelegatedSessionsForRail,
  revealGeneratedArtifactInSurface,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  resolveSelectedTurnId,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat/chat-page-pure-helpers";

export {
  formatSessionLabel,
  looksMachineSessionLabel,
  resolveMissionControlMessageMode,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
} from "./chat/useMissionControlSurfaceState";

import type { ChatMode } from "@goatcitadel/contracts";

/**
 * The surfaceMode handed to the outbound send hook. `undefined` on a new unlocked
 * thread with no override is REQUIRED so the gateway auto-router fires
 * (shouldAutoRouteSend gates on surfaceMode === undefined). A locked surface forces
 * its mode; an explicit override sends that mode.
 */
export function resolveOutboundSurfaceMode(input: {
  lockSurface: boolean;
  surface: ChatMode | undefined;
  modeOverride: ChatMode | null;
}): ChatMode | undefined {
  if (input.lockSurface && input.surface) {
    return input.surface;
  }
  return input.modeOverride ?? undefined;
}

/**
 * Confidence floor below which a predicted-code auto-route send asks the
 * operator to confirm before routing into Code.
 */
export const CODE_SEND_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Pre-send gate decision for a predicted-code auto-route turn.
 * - `unbound`: code predicted but no project is bound to the thread.
 * - `low_confidence`: code predicted, project bound, but confidence is below threshold.
 * - `null`: send normally (not auto-routing, not code, no preview, or bound+confident).
 */
export type CodeSendGate = { reason: "unbound" | "low_confidence" } | null;

/**
 * Decide whether a send should be gated before a predicted-code auto-route turn.
 *
 * Fail-open by design: when auto-routing is inactive, the prediction is not
 * `code`, or there is no preview at all (`predictedMode === undefined`), this
 * returns `null` so the send proceeds without interruption. A send is never
 * blocked because classify failed.
 */
export function resolveCodeSendGate(input: {
  autoRouteActive: boolean;
  predictedMode: ChatMode | undefined;
  predictedConfidence: number | undefined;
  hasBoundProject: boolean;
  threshold?: number;
}): CodeSendGate {
  if (!input.autoRouteActive || input.predictedMode !== "code") return null; // fail-open + non-code
  if (!input.hasBoundProject) return { reason: "unbound" };
  if ((input.predictedConfidence ?? 1) < (input.threshold ?? CODE_SEND_CONFIDENCE_THRESHOLD)) {
    return { reason: "low_confidence" };
  }
  return null;
}
