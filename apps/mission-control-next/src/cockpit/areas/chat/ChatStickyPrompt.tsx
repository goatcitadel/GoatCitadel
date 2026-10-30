import { ArrowUp } from "lucide-react";

/**
 * Keeps the question in view while its answer is read: once the question has scrolled off the top, a one-line bar
 * shows its start, and clicking it scrolls back to the full question.
 */
export function ChatStickyPrompt({
  position,
  promptStart,
  onJump,
}: {
  /** One-based position of the turn in the conversation. */
  position: number;
  promptStart: string;
  onJump: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-2 sm:px-6">
      <button
        type="button"
        onClick={onJump}
        aria-label={`Back to message ${position}: ${promptStart}`}
        className="pointer-events-auto mx-auto flex w-full max-w-3xl items-center gap-2 rounded-md border border-line-subtle bg-overlay px-3 py-1.5 text-left text-sm text-fg-secondary shadow-overlay hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-chat-sticky-prompt
      >
        <ArrowUp aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
        <span className="shrink-0 text-xs text-fg-muted">You asked</span>
        <span className="min-w-0 truncate">{promptStart}</span>
      </button>
    </div>
  );
}
