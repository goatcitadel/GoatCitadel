import { useCallback, useEffect, useState } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";

const PROMPT_START_WORDS = 12;
/** How much of a turn must still be on screen below the top edge for its question to count as scrolled away. */
const ANSWER_STILL_SHOWING_PX = 48;

export type TranscriptPosition = {
  /** The turn at the top of the view: the last one whose top edge has reached the top of the scroller. */
  currentTurnId: string | null;
  /** True when that turn's question has scrolled up out of view while its answer is still showing. */
  promptHidden: boolean;
};

const AT_START: TranscriptPosition = { currentTurnId: null, promptHidden: false };

/** The start of what the person asked in a turn, on one line, for the sticky prompt and the turn rail. */
export function turnPromptStart(turn: ChatThreadTurnRecord): string {
  const text = getWorkflowSkillCaptureDisplay(turn.userMessage.content)?.summary ?? turn.userMessage.content;
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "Message with no text";
  return words.slice(0, PROMPT_START_WORDS).join(" ") + (words.length > PROMPT_START_WORDS ? "…" : "");
}

function readPosition(scroller: HTMLElement): TranscriptPosition {
  const top = scroller.getBoundingClientRect().top;
  let current: HTMLElement | null = null;
  for (const article of scroller.querySelectorAll<HTMLElement>("article[data-turn-id]")) {
    if (article.getBoundingClientRect().top > top + 1) break;
    current = article;
  }
  if (!current) return AT_START;
  const prompt = current.querySelector<HTMLElement>("[data-turn-prompt]");
  const promptHidden =
    Boolean(prompt && prompt.getBoundingClientRect().bottom < top) &&
    current.getBoundingClientRect().bottom > top + ANSWER_STILL_SHOWING_PX;
  return { currentTurnId: current.dataset.turnId ?? null, promptHidden };
}

/**
 * Follows the transcript's scroll position once per frame. It only reads layout; scrolling stays with the
 * transcript's own follow and reading owner. `turnKeys` re-reads the position when turns are added or replaced.
 */
export function useTranscriptPosition(scroller: HTMLElement | null, turnKeys: readonly string[]): TranscriptPosition {
  const [position, setPosition] = useState<TranscriptPosition>(AT_START);
  const update = useCallback(() => {
    if (!scroller) return;
    const next = readPosition(scroller);
    setPosition((previous) =>
      previous.currentTurnId === next.currentTurnId && previous.promptHidden === next.promptHidden ? previous : next,
    );
  }, [scroller]);
  useEffect(() => {
    if (!scroller) {
      setPosition(AT_START);
      return;
    }
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, update, turnKeys]);
  return position;
}
