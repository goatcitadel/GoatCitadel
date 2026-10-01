import { createElement, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Virtuoso, type ItemProps, type ListProps, type ListRange, type VirtuosoHandle } from "react-virtuoso";

type RowAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
interface ListContext { label: string; ordered: boolean; total: number; attributes: (index: number) => RowAttributes }
function setElementRef(ref: Ref<HTMLElement>, element: HTMLElement | null) {
  if (typeof ref === "function") ref(element); else if (ref) ref.current = element;
}
const SemanticList = forwardRef<HTMLElement, Omit<ListProps, "ref"> & { context?: ListContext }>(
  function SemanticList({ context, ...props }, ref) {
    return createElement(context?.ordered ? "ol" : "ul", { ...props, ref: (element: HTMLElement | null) => setElementRef(ref, element), "aria-label": context?.label });
  },
);
const SemanticItem = forwardRef<HTMLElement, ItemProps<unknown> & { context?: ListContext }>(
  function SemanticItem({ context, item: _item, ...props }, ref) {
    void _item;
    return <li {...props} {...context?.attributes(props["data-index"])} ref={(element) => setElementRef(ref, element)} aria-setsize={context?.total} aria-posinset={props["data-index"] + 1} />;
  },
);
const COMPONENTS = { List: SemanticList, Item: SemanticItem };
export interface WindowedRecordListHandle { focusRecord: (key: string, selector?: string) => void }

/** Window DOM rows only; records, pagination, selection and authority remain with callers. */
export function WindowedRecordList<T>({ items, itemKey, children, label, ordered = false, threshold = 100,
  className = "h-96", listRef, onVisibleRangeChange, rowAttributes }: {
  items: readonly T[]; itemKey: (item: T) => string; children: (item: T, index: number) => ReactNode;
  label: string; ordered?: boolean; threshold?: number; className?: string;
  rowAttributes?: (item: T) => RowAttributes;
  listRef?: Ref<WindowedRecordListHandle>; onVisibleRangeChange?: (range: ListRange) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const virtual = useRef<VirtuosoHandle>(null);
  const [pendingFocus, setPendingFocus] = useState<{ key: string; selector: string } | null>(null);
  const [range, setRange] = useState<ListRange>({ startIndex: 0, endIndex: -1 });
  const windowed = items.length > threshold;
  const focusRecord = useCallback((key: string, selector = "button:not(:disabled), a[href], [tabindex='0']") => {
    const index = items.findIndex((item) => itemKey(item) === key);
    if (index < 0) return;
    setPendingFocus({ key, selector });
    if (windowed) virtual.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
  }, [items, itemKey, windowed]);
  useImperativeHandle(listRef, () => ({ focusRecord }), [focusRecord]);
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    if (!items.some((item) => itemKey(item) === pendingFocus.key)) { setPendingFocus(null); return; }
    const row = [...(host.current?.querySelectorAll<HTMLElement>("[data-record-key]") ?? [])]
      .find((element) => element.dataset.recordKey === pendingFocus.key);
    const target = row?.querySelector<HTMLElement>(pendingFocus.selector);
    if (target) { target.focus({ preventScroll: true }); setPendingFocus(null); }
  }, [pendingFocus, range, items, itemKey]);
  useEffect(() => {
    if (!windowed) onVisibleRangeChange?.({ startIndex: 0, endIndex: items.length - 1 });
  }, [windowed, items.length, onVisibleRangeChange]);
  const rangeChanged = useCallback((next: ListRange) => {
    setRange(next); onVisibleRangeChange?.(next);
  }, [onVisibleRangeChange]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !(event.target instanceof HTMLElement) || event.target.closest("input,textarea,select,[contenteditable='true']")) return;
    const key = event.target.closest<HTMLElement>("[data-record-key]")?.dataset.recordKey;
    const index = items.findIndex((item) => itemKey(item) === key);
    if (index < 0) return;
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); focusRecord(itemKey(items[next]!));
  }
  const render = (item: T, index: number) => <div data-record-key={itemKey(item)} className="pb-2">{children(item, index)}</div>;
  return <div ref={host} onKeyDown={onKeyDown} className={windowed ? className : undefined}>
    {windowed ? <Virtuoso ref={virtual} data={[...items]} className="h-full w-full"
      context={{ label, ordered, total: items.length, attributes: (index: number) => items[index] ? rowAttributes?.(items[index]!) ?? {} : {} }} components={COMPONENTS} rangeChanged={rangeChanged}
      computeItemKey={(_index, item) => itemKey(item)} itemContent={(index, item) => render(item, index)} />
      : createElement(ordered ? "ol" : "ul", { "aria-label": label }, items.map((item, index) =>
        <li key={itemKey(item)} {...rowAttributes?.(item)} aria-setsize={items.length} aria-posinset={index + 1}>{render(item, index)}</li>))}
  </div>;
}
