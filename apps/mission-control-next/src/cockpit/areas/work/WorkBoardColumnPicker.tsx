import type { WorkBoardGroup } from "./work-board";

export interface WorkBoardColumnChoice {
  id: WorkBoardGroup;
  title: string;
  /** Records shown in that column under the current search and record-type filter. */
  shown: number;
}

/**
 * Below the four-column width the board shows one column at a time; this row picks which. Each choice names its
 * column and how many records it shows, and the pressed state is announced, so the choice never relies on colour.
 * The row scrolls sideways instead of wrapping on the narrowest phones.
 */
export function WorkBoardColumnPicker({
  columns,
  current,
  onChange,
}: {
  columns: readonly WorkBoardColumnChoice[];
  current: WorkBoardGroup;
  onChange: (column: WorkBoardGroup) => void;
}) {
  return (
    <div role="group" aria-label="Board column" className="cockpit-area-tabs flex gap-1 border-b border-line-subtle">
      {columns.map((column) => (
        <button
          key={column.id}
          type="button"
          aria-pressed={current === column.id}
          onClick={() => onChange(column.id)}
          className="min-h-11 border-b-2 border-transparent px-3 text-sm text-fg-secondary hover:text-fg aria-pressed:border-accent aria-pressed:font-medium aria-pressed:text-fg"
        >
          {column.title} <span className="tabular-nums text-fg-muted">{column.shown}</span>
        </button>
      ))}
    </div>
  );
}
