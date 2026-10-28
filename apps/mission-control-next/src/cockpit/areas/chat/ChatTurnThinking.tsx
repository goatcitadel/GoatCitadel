import { ChevronRight } from "lucide-react";
import { useId } from "react";

const PREVIEW_CHARS = 140;

/** The newest line of the model's reasoning, cut to its last few words, for the one-line preview while it thinks. */
export function thinkingPreviewLine(thinking: string): string {
  const lines = thinking.split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  const last = lines.filter((line) => line.length > 0).at(-1) ?? "";
  return last.length > PREVIEW_CHARS ? `…${last.slice(-PREVIEW_CHARS).trimStart()}` : last;
}

/**
 * The model's streamed reasoning for a turn (`ChatThreadTurnRecord.thinking`), shut by default so the answer stays
 * first. While the model is still thinking and no answer has arrived, the summary shows its newest line. That line is
 * hidden from screen readers so the summary's name does not change with every reasoning chunk; the steady "Thinking…"
 * label says the same thing once. Renders nothing when the Gateway sent no reasoning (its thinking stream is off by
 * default), and reasoning is never saved, so a reloaded turn has none.
 */
export function ChatTurnThinking({
  thinking,
  live,
  answerStarted,
}: {
  thinking: string | undefined;
  /** The turn has not reached a final status. */
  live: boolean;
  answerStarted: boolean;
}) {
  const bodyId = useId();
  if (!thinking?.trim()) return null;
  const thinkingNow = live && !answerStarted;
  const preview = thinkingNow ? thinkingPreviewLine(thinking) : "";
  return (
    <details className="group mb-2 text-xs text-fg-muted" data-testid="chat-turn-thinking">
      <summary className="flex cursor-pointer items-center gap-1.5" aria-controls={bodyId}>
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 group-open:rotate-90" />
        <span className="shrink-0 font-medium">{thinkingNow ? "Thinking…" : "Thought process"}</span>
        {preview ? (
          <span aria-hidden="true" className="min-w-0 truncate italic">
            {preview}
          </span>
        ) : null}
      </summary>
      <div
        id={bodyId}
        className="mt-1 max-h-56 overflow-auto border-l-2 border-line-subtle pl-3 whitespace-pre-wrap wrap-anywhere italic text-fg-secondary"
      >
        {thinking}
      </div>
    </details>
  );
}
