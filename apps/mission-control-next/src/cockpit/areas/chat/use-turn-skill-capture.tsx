import { lazy, Suspense, type ReactNode } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { skillCaptureVisibility } from "./chat-skill-capture";
import type { TurnActions } from "./use-turn-actions";

const WorkflowSkillCaptureControl = lazy(() =>
  import("../../../features/native-routes/library/WorkflowSkillCaptureControl").then((module) => ({
    default: module.WorkflowSkillCaptureControl,
  })),
);

/**
 * Save as skill for one turn. It is offered from the answer's More menu; choosing it opens the existing capture
 * block, which keeps its own governance (prepare in the composer, review the draft, stage an inactive candidate,
 * review activation as a change plan). `eligible` is false for a read-only history, a channel message or a turn
 * still streaming.
 */
export function useTurnSkillCapture(
  turn: ChatThreadTurnRecord,
  actions: Pick<TurnActions, "workspaceId" | "selectedSessionId" | "onDraftChange" | "composerRef" | "onReviewPlan">,
  eligible: boolean,
  draftEmpty: boolean,
): { onSaveAsSkill?: () => void; control: ReactNode } {
  const [requested, setRequested] = useSessionViewState(
    JSON.stringify(["chat-skill-capture", actions.workspaceId, actions.selectedSessionId, turn.turnId]),
    false,
  );
  const visibility = eligible && actions.selectedSessionId ? skillCaptureVisibility(turn, requested) : "hidden";
  if (visibility === "hidden") return { control: null };
  if (visibility === "offered") return { onSaveAsSkill: () => setRequested(true), control: null };
  return {
    control: (
      <Suspense fallback={<p aria-busy="true">Loading skill capture…</p>}>
        <WorkflowSkillCaptureControl
          turn={turn}
          sessionId={actions.selectedSessionId!}
          workspaceId={actions.workspaceId}
          draftEmpty={draftEmpty}
          initialOpen={requested}
          onClosed={() => setRequested(false)}
          onPrepare={(prompt) => {
            actions.onDraftChange(prompt);
            actions.composerRef.current?.focus();
          }}
          onReviewPlan={actions.onReviewPlan}
        />
      </Suspense>
    ),
  };
}
