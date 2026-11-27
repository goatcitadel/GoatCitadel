import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { skillCaptureVisibility } from "./chat-skill-capture";
import type { TurnActions } from "./use-turn-actions";

const MORE_BUTTON = 'button[aria-label="More message actions"]';

const WorkflowSkillCaptureControl = lazy(() =>
  import("../../../features/native-routes/library/WorkflowSkillCaptureControl").then((module) => ({
    default: module.WorkflowSkillCaptureControl,
  })),
);

/**
 * Save as skill for one turn. Either turn action opens the existing capture
 * block, which keeps its own governance (prepare in the composer, review the draft, stage an inactive candidate,
 * review activation as a change plan). `eligible` is false for a read-only history, a channel message or a turn
 * still streaming.
 */
export function useTurnSkillCapture(
  turn: ChatThreadTurnRecord,
  actions: Pick<TurnActions, "workspaceId" | "selectedSessionId" | "onDraftChange" | "composerRef" | "onReviewPlan">,
  eligible: boolean,
  draftEmpty: boolean,
): { onSaveAsSkill?: (source?: "inline" | "menu") => void; control: ReactNode } {
  const [requested, setRequested] = useSessionViewState(
    JSON.stringify(["chat-skill-capture", actions.workspaceId, actions.selectedSessionId, turn.turnId]),
    false,
  );
  // Set only by the menu choice, and lost on a remount, so scrolling back to this answer never moves focus.
  const [focusPending, setFocusPending] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const opener = useRef<"inline" | "menu">("menu");
  const closeBlock = () => {
    const article = wrapper.current?.closest("article");
    setRequested(false);
    queueMicrotask(() => {
      if (!article?.isConnected) return;
      const inline =
        opener.current === "inline" ? article.querySelector<HTMLElement>("[data-save-skill-action]") : null;
      (inline ?? article.querySelector<HTMLElement>(MORE_BUTTON))?.focus();
    });
  };
  const visibility = eligible && actions.selectedSessionId ? skillCaptureVisibility(turn, requested) : "hidden";
  if (visibility === "hidden") return { control: null };
  if (visibility === "offered")
    return {
      onSaveAsSkill: (source = "menu") => {
        opener.current = source;
        setFocusPending(true);
        setRequested(true);
      },
      control: null,
    };
  return {
    control: (
      <div ref={wrapper}>
        <Suspense fallback={<p aria-busy="true">Loading skill capture…</p>}>
          <WorkflowSkillCaptureControl
            turn={turn}
            sessionId={actions.selectedSessionId!}
            workspaceId={actions.workspaceId}
            draftEmpty={draftEmpty}
            initialOpen={requested}
            onClosed={closeBlock}
            focusOnOpen={focusPending}
            onFocused={() => setFocusPending(false)}
            onPrepare={(prompt) => {
              actions.onDraftChange(prompt);
              actions.composerRef.current?.focus();
            }}
            onReviewPlan={actions.onReviewPlan}
          />
        </Suspense>
      </div>
    ),
  };
}
