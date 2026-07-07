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
