import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../../lib/cn";

export type TurnRailEntry = { turnId: string; promptStart: string };

/** The rail starts at this many messages; below it the whole conversation fits a glance. */
export const TURN_RAIL_MIN_TURNS = 3;

/**
 * A long conversation shows this many ticks around the current message, plus its first and last message, so the rail
 * stays bounded and never clips. The window follows the current message, so every message stays reachable.
 */
export const TURN_RAIL_WINDOW = 40;

/** The indexes of the entries the rail shows, in order. */
export function turnRailIndexes(count: number, currentIndex: number): number[] {
  if (count <= TURN_RAIL_WINDOW + 2) return Array.from({ length: count }, (_, index) => index);
  const start = Math.min(Math.max(currentIndex - TURN_RAIL_WINDOW / 2, 1), count - 1 - TURN_RAIL_WINDOW);
  return [0, ...Array.from({ length: TURN_RAIL_WINDOW }, (_, offset) => start + offset), count - 1];
}

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
  const shown = turnRailIndexes(entries.length, currentIndex);
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
        {shown.map((index, order) => {
          const entry = entries[index]!;
          const current = index === currentIndex;
          // A small gap marks where the window skips messages.
          const skipsAfter = (shown[order + 1] ?? index + 1) > index + 1;
          const skipsBefore = order > 0 && shown[order - 1]! < index - 1;
          return (
            <li
              key={entry.turnId}
              className={cn("flex max-h-6 min-h-0.5 flex-1", skipsAfter && "mb-2", skipsBefore && "mt-2")}
            >
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
