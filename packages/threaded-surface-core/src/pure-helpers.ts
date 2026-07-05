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
 * Historical confidence floor for the old predicted-code confirmation gate.
 * Kept exported for compatibility with callers/tests that import the constant.
 */
export const CODE_SEND_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Pre-send gate decision for a predicted-code auto-route turn.
 * The classifier is now advisory for the unified chat surface: a code-leaning
 * first turn still sends from the same composer, and Gateway/runtime policy
 * decides whether any governed capability action or project binding is needed.
 */
export type CodeSendGate = { reason: "unbound" | "low_confidence" } | null;

/**
 * Decide whether a send should be gated before a predicted-code auto-route turn.
 *
 * Fail-open by design: first-turn classification should inform routing and
 * visible previews, but it should not ask the operator to switch modes before
 * the message can be handled.
 */
export function resolveCodeSendGate(_input: {
  autoRouteActive: boolean;
  predictedMode: ChatMode | undefined;
  predictedConfidence: number | undefined;
  hasBoundProject: boolean;
  threshold?: number;
}): CodeSendGate {
  return null;
}
