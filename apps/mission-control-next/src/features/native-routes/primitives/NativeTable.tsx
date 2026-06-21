import { type ReactNode } from "react";
import { clsx } from "clsx";
import { EmptyState } from "./EmptyState";

/**
 * NativeTable — the columnar, scannable operator table for mission-control-next.
 *
 * Sibling to NativeList: where NativeList renders titled, variable-height,
 * prose-bearing rows (title / meta / body), NativeTable renders homogeneous
 * rows with aligned columns, right-aligned tabular numerics, and a sticky
 * header — the shape operators need to scan a column of figures (cost, latency,
 * counts) which the def-list NativeList cannot provide.
 *
 * Bespoke (not the shared shadcn `ui/table.tsx`, which is Tailwind-classed and
 * renders unstyled in mc-next): a real semantic <table> styled in
 * native-routes.css, so it carries free row/column semantics for assistive tech.
 */
export interface NativeTableColumn<Row> {
  key: string;
  header: string;
  /** Right-align the column and render values with tabular-nums (for figures). */
  numeric?: boolean;
  /** Override alignment independently of `numeric`. */
  align?: "start" | "end";
  /** Optional fixed column width, e.g. "8rem" or "1%" (shrink-to-content). */
  width?: string;
  /** Render arbitrary cell content. Falls back to `cell`, then nothing. */
  render?: (row: Row) => ReactNode;
  /** Plain-text cell accessor (used when `render` is absent). */
  cell?: (row: Row) => string;
}

export interface NativeTableProps<Row> {
  columns: NativeTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  /** Accessible name (required — operator tables are data, not decoration). */
  ariaLabel: string;
  /** Optional screen-reader caption. */
  caption?: string;
  emptyLabel?: string;
  density?: "standard" | "compact";
  /** When set, the body scrolls within this height and the header stays sticky. */
  maxHeight?: string;
  /** Sticky header (default true). */
  stickyHeader?: boolean;
}

function columnAlign<Row>(col: NativeTableColumn<Row>): "start" | "end" {
  return col.align ?? (col.numeric ? "end" : "start");
}

export function NativeTable<Row>({
  columns,
  rows,
  getRowKey,
  ariaLabel,
  caption,
  emptyLabel = "Nothing here yet.",
  density = "standard",
  maxHeight,
  stickyHeader = true,
}: NativeTableProps<Row>) {
  if (rows.length === 0) {
    return <EmptyState size="compact" title={emptyLabel} />;
  }
  return (
    <div
      className={clsx("mc-next-native-table-wrap", maxHeight && "is-scrollable")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table
        className={clsx(
          "mc-next-native-table",
          density === "compact" && "is-compact",
          stickyHeader && "has-sticky-head",
        )}
        aria-label={ariaLabel}
      >
        {caption ? <caption className="mc-next-sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                data-align={columnAlign(col)}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getRowKey(row, index)}>
              {columns.map((col) => (
                <td key={col.key} data-align={columnAlign(col)} data-numeric={col.numeric ? "true" : undefined}>
                  {col.render ? col.render(row) : col.cell ? col.cell(row) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
