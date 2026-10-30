import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../../lib/cn";

export type TurnRailEntry = { turnId: string; promptStart: string };

/** The rail starts at this many messages; below it the whole conversation fits a glance. */
export const TURN_RAIL_MIN_TURNS = 3;

/**
 * One tick per message down the right edge of the transcript. A tick names the start of its question and jumps to it;
 * the tick for the message at the top of the view is marked current. The rail is one tab stop: the arrow keys, Home
 * and End move between ticks.
 */
export function ChatTurnRail({
  entries,
  currentTurnId,
  onJump,
}: {
  entries: readonly TurnRailEntry[];
  currentTurnId: string | null;
  onJump: (turnId: string, index: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  if (entries.length < TURN_RAIL_MIN_TURNS) return null;
  const currentIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.turnId === currentTurnId),
  );
  const moveFocus = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    const to =
      event.key === "ArrowDown"
        ? Math.min(from + 1, buttons.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(from - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    buttons[to]?.focus();
  };
  return (
    <nav
      aria-label="Messages in this conversation"
      className="absolute bottom-16 right-1 top-14 z-10 hidden w-4 md:flex"
      data-chat-turn-rail
    >
      <ol ref={list} onKeyDown={moveFocus} className="flex h-full w-full flex-col justify-center overflow-hidden">
        {entries.map((entry, index) => {
          const current = index === currentIndex;
          return (
            <li key={entry.turnId} className="flex max-h-6 min-h-0.5 flex-1">
              <button
                type="button"
                tabIndex={current ? 0 : -1}
                aria-current={current ? "location" : undefined}
                aria-label={`Message ${index + 1}: ${entry.promptStart}`}
                title={`Message ${index + 1}: ${entry.promptStart}`}
                onClick={() => onJump(entry.turnId, index)}
                className="group/tick flex w-full items-center justify-end focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "block h-0.5 rounded-full transition-[width,background-color] motion-reduce:transition-none",
                    current ? "w-3 bg-accent" : "w-2 bg-line-strong group-hover/tick:w-3 group-hover/tick:bg-fg-muted",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
