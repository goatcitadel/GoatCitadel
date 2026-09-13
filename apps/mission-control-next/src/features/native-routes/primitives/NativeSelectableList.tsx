import { lazy, Suspense, useRef, type ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
const WindowedSelectableRows = lazy(() => import("./WindowedSelectableRows").then((module) => ({ default: module.WindowedSelectableRows })));
import { EmptyState } from "./EmptyState";

/**
 * Canonical selectable-list primitive — the single home for the scrollable
 * "pick one row" pattern that was duplicated as `SettingsSelectableList`
 * (settings/SettingsShared) and `LibrarySelectableList` (shared/library-primitives)
 * and hand-rolled in ProjectsRoutePage / MemoryRoutePage.
 *
 * Two modes:
 *  - data mode: pass `items` (+ `selectedId`/`onSelect`) for the default
 *    title/meta/body rows (Settings, Library).
 *  - children mode: pass `children` for custom rows that still want the shared
 *    list shell (scroll container, density, gap) — e.g. Projects' card grid.
 *
 * The emitted `mc-next-settings-selectable*` classes are legacy-shared across
 * several features; they are intentionally left un-renamed here (a neutral
 * rename is a separate CSS cleanup) so adoption is visually neutral.
 */
export interface NativeSelectableListItem {
  id: string;
  title: string;
  meta?: ReactNode;
  body?: ReactNode;
}

export interface NativeSelectableListProps {
  /** Data mode: default rows rendered from these items. */
  items?: NativeSelectableListItem[];
  /** Active row id (data mode). */
  selectedId?: string;
  /** Row click handler (data mode). */
  onSelect?: (id: string) => void;
  /** Children mode: custom rows; caller owns row markup and empties. */
  children?: ReactNode;
  /** Shown when data mode has no items (ignored in children mode). */
  emptyLabel?: string;
  /** Overrides the default EmptyState when data mode is empty. */
  emptyContent?: ReactNode;
  maxHeight?: string;
  density?: "standard" | "compact";
  className?: string;
  ariaLabel?: string;
  virtualized?: boolean;
}

export function NativeSelectableList({
  items,
  selectedId,
  onSelect,
  children,
  emptyLabel = "Nothing here yet.",
  emptyContent,
  maxHeight = "min(56vh, 34rem)",
  density = "compact",
  className,
  ariaLabel,
  virtualized = false,
}: NativeSelectableListProps) {
  const virtualList = useRef<VirtuosoHandle>(null);
  const rowButtons = useRef(new Map<number, HTMLButtonElement>());
  const focusTarget = useRef<number | null>(null);
  const windowed = virtualized && !children && Boolean(maxHeight) && (items?.length ?? 0) > 50;
  const renderRow = (item: NativeSelectableListItem, index: number) => <button key={item.id} type="button"
    ref={(node) => { if (node) { rowButtons.current.set(index, node); if (focusTarget.current === index) { focusTarget.current = null; node.focus(); } } else rowButtons.current.delete(index); }}
    className={`mc-next-settings-selectable${selectedId === item.id ? " active" : ""}`} aria-pressed={selectedId === undefined ? undefined : selectedId === item.id}
    onClick={() => onSelect?.(item.id)} onKeyDown={(event) => {
      let target: number;
      if (event.key === "ArrowDown") target = Math.min((items?.length ?? 1) - 1, index + 1);
      else if (event.key === "ArrowUp") target = Math.max(0, index - 1);
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = (items?.length ?? 1) - 1;
      else return;
      event.preventDefault(); focusTarget.current = target;
      const button = rowButtons.current.get(target);
      if (button) { focusTarget.current = null; button.focus(); }
      else virtualList.current?.scrollToIndex({ index: target, align: "center" });
    }}><div className="mc-next-settings-selectable-head"><strong>{item.title}</strong>{item.meta ? <span>{item.meta}</span> : null}</div>{item.body ? <p>{item.body}</p> : null}</button>;
  if (!children && (!items || items.length === 0)) {
    return emptyContent ?? <EmptyState size="compact" title={emptyLabel} />;
  }
  return (
    <div
      className={[
        "mc-next-settings-selectable-list",
        density === "compact" ? "is-compact" : "",
        maxHeight ? "is-scrollable" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {children ?? (windowed ? <Suspense fallback={items!.map(renderRow)}><WindowedSelectableRows listRef={virtualList} items={items!} maxHeight={maxHeight} renderRow={renderRow} /></Suspense> : items!.map(renderRow))}
    </div>
  );
}
