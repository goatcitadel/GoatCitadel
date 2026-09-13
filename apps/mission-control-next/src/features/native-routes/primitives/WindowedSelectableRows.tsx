import type { ReactNode, RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { NativeSelectableListItem } from "./NativeSelectableList";

export function WindowedSelectableRows({ items, maxHeight, listRef, renderRow }: {
  items: NativeSelectableListItem[];
  maxHeight: string;
  listRef: RefObject<VirtuosoHandle | null>;
  renderRow: (item: NativeSelectableListItem, index: number) => ReactNode;
}) {
  return <Virtuoso ref={listRef} data={items} style={{ height: maxHeight }} initialItemCount={12}
    computeItemKey={(_index, item) => item.id} itemContent={(index, item) => renderRow(item, index)} />;
}
