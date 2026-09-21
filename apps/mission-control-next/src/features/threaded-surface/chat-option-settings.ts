/**
 * One armed setting that changes what the next Send will do. Surfaced next to the
 * Options trigger rather than hidden behind it: "Options · active" told the operator
 * that something was on without saying what, and these settings can change where the
 * work runs and what it reaches.
 *
 * Kept out of ChatOptionsPopover.tsx so tests that mock the popover component still
 * exercise the real derivation.
 */
export interface ChatOptionActiveSetting {
  id: string;
  label: string;
  /** What this setting does, shown on hover/focus. */
  description: string;
}

/**
 * Names the settings that change what the next Send does. Deliberately omits
 * defaults/off states — a chip should mean "this is armed", not "this exists".
 */
export function buildActiveChatOptionSettings({
  planningMode,
  webMode,
  reviewDepth,
  modelCouncilEnabled,
}: {
  planningMode?: string;
  webMode?: string;
  reviewDepth?: string;
  modelCouncilEnabled: boolean;
}): ChatOptionActiveSetting[] {
  const settings: ChatOptionActiveSetting[] = [];
  if (planningMode === "advisory") {
    settings.push({
      id: "planning",
      label: "Plan mode",
      description: "Drafts a plan for your next message before doing the work.",
    });
  }
  if (webMode === "deep") {
    settings.push({
      id: "web",
      label: "Deep research",
      description: "Reaches the open web and researches across multiple sources.",
    });
  } else if (webMode === "quick") {
    settings.push({
      id: "web",
      label: "Web research",
      description: "Reaches the open web for quick lookups.",
    });
  }
  if (reviewDepth && reviewDepth !== "off") {
    settings.push({
      id: "review",
      label: reviewDepth === "standard" ? "Review" : `Review: ${reviewDepth}`,
      description: "Runs a review pass over the result before returning it.",
    });
  }
  if (modelCouncilEnabled) {
    settings.push({
      id: "council",
      label: "Model council",
      description: "Asks several models and reconciles their answers.",
    });
  }
  return settings;
}
