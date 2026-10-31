import { useState } from "react";
import { X } from "lucide-react";
import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";

const NO_SUGGESTIONS: ChatCapabilityUpgradeSuggestion[] = [];

/**
 * The suggestions a turn offers under its reply: only the selected turn (the latest when none is selected) and never
 * a read-only historical view, because accepting one changes the workspace.
 */
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

function SuggestionRow({
  suggestion,
  onAction,
  onDismiss,
}: {
  suggestion: ChatCapabilityUpgradeSuggestion;
  onAction(suggestion: ChatCapabilityUpgradeSuggestion): void;
  onDismiss(suggestion: ChatCapabilityUpgradeSuggestion): void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
      <button
        type="button"
        className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => onAction(suggestion)}
      >
        {suggestion.title}
      </button>
      <details>
        <summary className="cursor-pointer">Why?</summary>
        <p>{suggestion.summary}</p>
        <p>{suggestion.reason}</p>
      </details>
      <button
        type="button"
        aria-label={`Dismiss suggestion: ${suggestion.title}`}
        className="rounded p-0.5 hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => onDismiss(suggestion)}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

/** One quiet row under a reply offering the first capability suggestion; `+N more` shows the others. */
export function ChatCapabilitySuggestionLine(props: {
  suggestions: ChatCapabilityUpgradeSuggestion[];
  onAction(suggestion: ChatCapabilityUpgradeSuggestion): void;
  onDismiss(suggestion: ChatCapabilityUpgradeSuggestion): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.suggestions.length === 0) return null;
  const hidden = props.suggestions.length - 1;
  const shown = expanded ? props.suggestions : props.suggestions.slice(0, 1);
  return (
    <div aria-label="Suggested capabilities">
      <ul className="space-y-1">
        {shown.map((suggestion) => (
          <SuggestionRow
            key={`${suggestion.kind}:${suggestion.candidateId ?? suggestion.title}`}
            suggestion={suggestion}
            onAction={props.onAction}
            onDismiss={props.onDismiss}
          />
        ))}
      </ul>
      {hidden > 0 && !expanded ? (
        <button
          type="button"
          className="text-xs text-fg-muted underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => setExpanded(true)}
        >
          +{hidden} more
        </button>
      ) : null}
    </div>
  );
}
