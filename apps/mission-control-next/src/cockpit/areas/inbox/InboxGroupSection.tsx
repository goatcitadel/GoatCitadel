import type { ReactNode } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { WindowedRecordList, type WindowedRecordListHandle } from "../../ui/WindowedRecordList";
import { inboxGroupCountLabel, type InboxViewGroupId } from "./inbox-triage";

/** One Inbox group: its heading and truthful count, optional controls, then its rows or one empty line. */
export function InboxGroupSection({
  group,
  items,
  known,
  exact,
  filtered,
  emptyMessage,
  controls,
  selectedId,
  listRef,
  renderItem,
}: {
  group: { id: InboxViewGroupId; label: string };
  items: OperatorInboxItem[];
  known: number;
  exact: boolean;
  filtered: boolean;
  emptyMessage: string;
  controls?: ReactNode;
  selectedId: string | null;
  listRef: (handle: WindowedRecordListHandle | null) => void;
  renderItem: (item: OperatorInboxItem) => ReactNode;
}) {
  return (
    <section aria-labelledby={`inbox-${group.id}`} className="grid gap-3">
      <header className="flex items-baseline gap-2">
        <h2 id={`inbox-${group.id}`} className="text-md font-semibold text-fg">
          {group.label}
        </h2>
        <span data-inbox-count={group.id} className="text-xs text-fg-muted">
          {inboxGroupCountLabel({ known, exact, shown: items.length, filtered })}
        </span>
      </header>
      {controls}
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">{emptyMessage}</p>
      ) : (
        <WindowedRecordList
          items={items}
          itemKey={(item) => item.id}
          label={group.label}
          rowAttributes={(item) => ({
            "data-inbox-item": true,
            "data-inbox-row": item.id,
            "data-selected": selectedId === item.id,
          })}
          listRef={listRef}
        >
          {renderItem}
        </WindowedRecordList>
      )}
    </section>
  );
}
