import { useMemo } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { useOptionalStableHandler, useStableHandler } from "../../../features/threaded-surface/useStableHandler";

/**
 * What every turn reads from the session surface. Values change only with the conversation; every handler keeps one
 * identity, so composer typing and streamed chunks leave the memoized turns alone. The selection reaches each turn as
 * its own capability suggestions instead, so moving it re-renders two turns, not all of them.
 */
export type TurnActions = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "historicalReadOnly"
  | "workspaceId"
  | "selectedSessionId"
  | "composerRef"
  | "onRefreshThread"
  | "onCapabilitySuggestionAction"
  | "onDismissCapabilitySuggestion"
  | "onDraftChange"
  | "onRetryTurn"
  | "onStartNewThreadFromTurn"
  | "onSwitchBranch"
  | "onEditTurn"
  | "onOpenRunDetails"
  | "onCreateGeneratedArtifact"
  | "onOpenGeneratedArtifact"
> & {
  /** Opens a change plan for review; hosts may rebuild it on every render, so it is held stable here too. */
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
};

/** A completed turn with a complete answer offers workflow-skill capture, the one turn control that reads the draft. */
export function turnReadsDraft(turn: ChatThreadTurnRecord): boolean {
  return turn.trace.status === "completed" && turn.trace.completion?.status === "complete";
}

/** The suggestions one turn offers; a turn receives its own list, never the selection itself. */
export { selectTurnCapabilitySuggestions } from "./ChatCapabilitySuggestionLine";

/** The surface props a turn reads, as one object that changes only when one of its values does. */
export function useTurnActions(
  props: MissionThreadedActiveSessionSurfaceProps,
  reviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"],
): TurnActions {
  const { historicalReadOnly, workspaceId, selectedSessionId, composerRef } = props;
  const onRefreshThread = useStableHandler(props.onRefreshThread);
  const onCapabilitySuggestionAction = useOptionalStableHandler(props.onCapabilitySuggestionAction);
  const onDismissCapabilitySuggestion = useOptionalStableHandler(props.onDismissCapabilitySuggestion);
  const onDraftChange = useStableHandler(props.onDraftChange);
  const onRetryTurn = useStableHandler(props.onRetryTurn);
  const onStartNewThreadFromTurn = useStableHandler(props.onStartNewThreadFromTurn);
  const onSwitchBranch = useStableHandler(props.onSwitchBranch);
  const onEditTurn = useStableHandler(props.onEditTurn);
  const onOpenRunDetails = useStableHandler(props.onOpenRunDetails);
  const onCreateGeneratedArtifact = useStableHandler(props.onCreateGeneratedArtifact);
  const onOpenGeneratedArtifact = useStableHandler(props.onOpenGeneratedArtifact);
  const onReviewPlan = useOptionalStableHandler(reviewPlan);
  return useMemo(
    () => ({
      historicalReadOnly,
      workspaceId,
      selectedSessionId,
      composerRef,
      onRefreshThread,
      onCapabilitySuggestionAction,
      onDismissCapabilitySuggestion,
      onDraftChange,
      onRetryTurn,
      onStartNewThreadFromTurn,
      onSwitchBranch,
      onEditTurn,
      onOpenRunDetails,
      onCreateGeneratedArtifact,
      onOpenGeneratedArtifact,
      onReviewPlan,
    }),
    [
      historicalReadOnly,
      workspaceId,
      selectedSessionId,
      composerRef,
      onRefreshThread,
      onCapabilitySuggestionAction,
      onDismissCapabilitySuggestion,
      onDraftChange,
      onRetryTurn,
      onStartNewThreadFromTurn,
      onSwitchBranch,
      onEditTurn,
      onOpenRunDetails,
      onCreateGeneratedArtifact,
      onOpenGeneratedArtifact,
      onReviewPlan,
    ],
  );
}
