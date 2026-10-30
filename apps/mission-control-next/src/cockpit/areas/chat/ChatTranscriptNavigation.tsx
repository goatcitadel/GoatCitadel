import { useCallback, useMemo, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { ChatStickyPrompt } from "./ChatStickyPrompt";
import { ChatTurnRail } from "./ChatTurnRail";
import { turnPromptStart, useTranscriptPosition } from "./use-transcript-position";

/**
 * The sticky question bar and the turn rail over the transcript. It owns the scroll-position reads, so scrolling
 * re-renders only this layer and never the turns themselves.
 */
export function ChatTranscriptNavigation({
  scroller,
  turns,
  turnKeys,
  virtuoso,
  onReaderJump,
}: {
  scroller: HTMLElement | null;
  turns: ChatThreadTurnRecord[];
  turnKeys: string[];
  /** Set while the transcript is virtualized, to reach a turn that is not rendered. */
  virtuoso: RefObject<VirtuosoHandle | null>;
  /** Marks the jump as the reader moving, so the transcript stops following new output. */
  onReaderJump: () => void;
}) {
  const position = useTranscriptPosition(scroller, turnKeys);
  const entries = useMemo(
    () => turns.map((turn) => ({ turnId: turn.turnId, promptStart: turnPromptStart(turn) })),
    [turns],
  );
  const jumpToTurn = useCallback(
    (turnId: string, index: number) => {
      if (!scroller) return;
      onReaderJump();
      const article = [...scroller.querySelectorAll<HTMLElement>("article[data-turn-id]")].find(
        (candidate) => candidate.dataset.turnId === turnId,
      );
      if (article) {
        scroller.scrollTop += article.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        return;
      }
      virtuoso.current?.scrollToIndex({ index, align: "start" });
    },
    [scroller, onReaderJump, virtuoso],
  );
  const stickyIndex = position.promptHidden ? turnKeys.indexOf(position.currentTurnId ?? "") : -1;
  const sticky = stickyIndex >= 0 ? entries[stickyIndex] : undefined;
  return (
    <>
      {sticky ? (
        <ChatStickyPrompt
          position={stickyIndex + 1}
          promptStart={sticky.promptStart}
          onJump={() => jumpToTurn(sticky.turnId, stickyIndex)}
        />
      ) : null}
      <ChatTurnRail entries={entries} currentTurnId={position.currentTurnId} onJump={jumpToTurn} />
    </>
  );
}
