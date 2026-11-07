import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";

const NO_SUGGESTIONS: ChatCapabilityUpgradeSuggestion[] = [];

/** Offer workspace changes only on the selected turn, or the latest when none is selected. */
export function selectTurnCapabilitySuggestions(
  actions: {
    capabilitySuggestions?: ChatCapabilityUpgradeSuggestion[];
    historicalReadOnly?: boolean;
    selectedTurnId?: string | null;
  },
  turnId: string,
  isLatest: boolean,
): ChatCapabilityUpgradeSuggestion[] {
  if (actions.historicalReadOnly) return NO_SUGGESTIONS;
  const offered = actions.selectedTurnId ? actions.selectedTurnId === turnId : isLatest;
  return offered ? (actions.capabilitySuggestions ?? NO_SUGGESTIONS) : NO_SUGGESTIONS;
}
