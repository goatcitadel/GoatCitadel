import { type ReactNode } from "react";
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
}: NativeSelectableListProps) {
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
      aria-label={ariaLabel}
    >
      {children ??
        items!.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mc-next-settings-selectable${selectedId === item.id ? " active" : ""}`}
            onClick={() => onSelect?.(item.id)}
          >
            <div className="mc-next-settings-selectable-head">
              <strong>{item.title}</strong>
              {item.meta ? <span>{item.meta}</span> : null}
            </div>
            {item.body ? <p>{item.body}</p> : null}
          </button>
        ))}
    </div>
  );
}
