import type { ChatMode } from "@goatcitadel/contracts";
import { useEffect, useRef } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  currentSessionMode: ChatMode;
  onResolvedModeChange: MissionThreadedControllerHostProps["onResolvedModeChange"];
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "setModeOverride" | "userAdjustedModeOverrideRef" | "initialModeOverrideRef" | "selectedSessionId"
  >;
};

/** Preserves URL/manual mode precedence and session synchronization effect order. */
export function useChatModeSynchronization({ currentSessionMode, onResolvedModeChange, selection }: Input) {
  const { setModeOverride } = selection;

  const lastEmittedModeRef = useRef<ChatMode | null>(null);
  useEffect(() => {
    if (currentSessionMode && currentSessionMode !== lastEmittedModeRef.current) {
      lastEmittedModeRef.current = currentSessionMode;
      onResolvedModeChange?.(currentSessionMode, "session-sync");
    }
  }, [currentSessionMode, onResolvedModeChange]);

  // Clear a stale override when the selected thread changes to prevent cross-thread leakage.
  // The override is read synchronously by the next send before this fires, so a same-thread
  // override still applies; on an existing code thread subsequent turns naturally remain code.
  // When an explicit URL override (initialModeOverride) is present, re-seed from it instead of
  // clearing to null so selecting another session while ?mode=chat is present keeps honoring
  // the URL (QA finding N3) rather than reverting to that session's own mode.
  //
  // EXCEPTION: the URL seed is a one-time force, not a standing one. If the operator has
  // manually changed the override since it was last (re-)seeded from the URL
  // (userAdjustedModeOverrideRef), their explicit choice takes precedence over the seed on a
  // session switch — the override clears to null and the newly-selected session's own mode
  // wins, exactly like the pre-existing behavior for an unseeded override. An untouched URL
  // seed keeps re-asserting itself on every session switch, as before.
  useEffect(() => {
    setModeOverride(
      selection.userAdjustedModeOverrideRef.current ? null : (selection.initialModeOverrideRef.current ?? null),
    );
  }, [
    selection.selectedSessionId,
    selection.initialModeOverrideRef,
    selection.userAdjustedModeOverrideRef,
    setModeOverride,
  ]);

  return {};
}
