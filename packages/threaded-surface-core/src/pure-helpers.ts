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

export function resolveOutboundSurfaceMode(input: {
  lockSurface: boolean;
  surface: ChatMode | undefined;
  modeOverride: ChatMode | null;
}): ChatMode | undefined {
  void input;
  return "chat";
}

/**
 * Historical confidence floor for the old predicted-code confirmation gate.
 * Kept exported for compatibility with callers/tests that import the constant.
 */
export const CODE_SEND_CONFIDENCE_THRESHOLD = 0.7;
