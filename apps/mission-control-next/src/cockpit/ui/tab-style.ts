/**
 * The one tab look (DESIGN.md › Page anatomy): a flat label on an underline slot, hover darkens the text, the current
 * tab draws the accent underline. `Tabs`, `OverflowTabs` and the Settings section tabs all take their classes from
 * here. The current mark is not colour alone: the accent underline carries it, and forced colours add the
 * aria-current and aria-selected outline in accessible-controls.css. Tailwind reads whole class names, so each variant
 * form is written out.
 */
export const TAB_CLASS =
  "min-h-9 border-b-2 border-transparent px-3 py-2 shadow-none text-sm text-fg-secondary hover:text-fg";

/** The current tab of a Radix tablist. */
export const TAB_ACTIVE_CLASS = "data-[state=active]:border-accent data-[state=active]:text-fg";

/** The current tab of a row of links. */
export const TAB_CURRENT_PAGE_CLASS = "aria-[current=page]:border-accent aria-[current=page]:text-fg";
