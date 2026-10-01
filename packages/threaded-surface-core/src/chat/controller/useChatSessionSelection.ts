import type { ChatMode } from "@goatcitadel/contracts";
import { useEffect, useRef, useState } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";

type Input = {
  initialModeOverride: MissionThreadedControllerHostProps["initialModeOverride"];
};

/** Owns session selection and URL mode precedence, retaining ref publication during render. */
export function useChatSessionSelection({ initialModeOverride }: Input) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Async work captures the error setter from the session in which it started.
  // Keep the current selection in a ref so a late rejection cannot attach its
  // recovery message to whichever chat the operator opened meanwhile.
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const [modeOverride, setModeOverride] = useState<ChatMode | null>(initialModeOverride ?? null);
  // Synced ref so the selectedSessionId-keyed reset effect below can read the
  // latest initialModeOverride without depending on it directly (it must only
  // re-run on session switch, not on every prop identity change).
  const initialModeOverrideRef = useRef(initialModeOverride);
  // Tracks whether the operator has manually changed the mode override (via the
  // ThreadedModeControl UI's onModeOverride callback) since the last time
  // initialModeOverride genuinely changed value. A URL-seeded override is a
  // one-time seed, not a standing force: once the operator diverges from it,
  // a session switch must not snap the override back to the URL's seed and
  // silently discard their explicit choice. Set true in the public
  // onModeOverride callback below; cleared when initialModeOverride's PROP
  // VALUE changes (a new navigation seed re-arms URL precedence).
  const userAdjustedModeOverrideRef = useRef(false);
  useEffect(() => {
    if (initialModeOverrideRef.current !== initialModeOverride) {
      userAdjustedModeOverrideRef.current = false;
    }
    initialModeOverrideRef.current = initialModeOverride;
  }, [initialModeOverride]);
  // Re-seed modeOverride whenever the prop changes to a defined value (e.g. the
  // URL gains ?mode=chat after mount), so navigating within the same session
  // still picks up a newly-explicit override.
  useEffect(() => {
    if (initialModeOverride !== undefined) {
      setModeOverride(initialModeOverride);
    }
  }, [initialModeOverride]);

  return {
    selectedSessionId,
    selectedSessionIdRef,
    historyView,
    setSelectedSessionId,
    setModeOverride,
    userAdjustedModeOverrideRef,
    initialModeOverrideRef,
    selectedProjectId,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    selectedTag,
    setSelectedTag,
    setHistoryView,
    modeOverride,
  };
}
