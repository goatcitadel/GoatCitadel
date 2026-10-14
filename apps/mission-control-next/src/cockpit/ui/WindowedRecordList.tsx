import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { ItemProps, ListProps, ListRange, VirtuosoHandle } from "react-virtuoso";
import { useDeferredVirtuoso } from "./DeferredVirtuoso";

type RowAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
interface ListContext {
  label: string;
  ordered: boolean;
  total: number;
  attributes: (index: number) => RowAttributes;
}
function setElementRef(ref: Ref<HTMLElement>, element: HTMLElement | null) {
  if (typeof ref === "function") ref(element);
  else if (ref) ref.current = element;
}
const SemanticList = forwardRef<HTMLElement, Omit<ListProps, "ref"> & { context?: ListContext }>(function SemanticList(
  { context, ...props },
  ref,
) {
  return createElement(context?.ordered ? "ol" : "ul", {
    ...props,
    ref: (element: HTMLElement | null) => setElementRef(ref, element),
    "aria-label": context?.label,
  });
});
const SemanticItem = forwardRef<HTMLElement, ItemProps<unknown> & { context?: ListContext }>(function SemanticItem(
  { context, item: _item, ...props },
  ref,
) {
  void _item;
  return (
    <li
      {...props}
      {...context?.attributes(props["data-index"])}
      ref={(element) => setElementRef(ref, element)}
      aria-setsize={context?.total}
      aria-posinset={props["data-index"] + 1}
    />
  );
});
const COMPONENTS = { List: SemanticList, Item: SemanticItem };
export interface WindowedRecordListHandle {
  focusRecord: (key: string, selector?: string) => void;
}
type FocusRequest = { key: string; selector: string; owner: object; origin: Element | null };
type FocusedControl = {
  element: HTMLElement;
  tag: string;
  label: string | null;
  labelledBy: string | null;
  role: string | null;
  type: string | null;
  text: string | null;
};
function controlIdentity(element: HTMLElement): FocusedControl {
  const label = element.getAttribute("aria-label"),
    labelledBy = element.getAttribute("aria-labelledby");
  return {
    element,
    tag: element.tagName,
    label,
    labelledBy,
    role: element.getAttribute("role"),
    type: element.getAttribute("type"),
    text: label || labelledBy ? null : element.textContent,
  };
}
function matchesControl(element: HTMLElement, control: FocusedControl) {
  const next = controlIdentity(element);
  return (
    next.tag === control.tag &&
    next.label === control.label &&
    next.labelledBy === control.labelledBy &&
    next.role === control.role &&
    next.type === control.type &&
    (control.text === null || next.text === control.text)
  );
}

/** Window DOM rows only; records, pagination, selection and authority remain with callers. */
export function WindowedRecordList<T>({
  items,
  itemKey,
  children,
  label,
  ordered = false,
  threshold = 100,
  className = "h-96",
  bounded = false,
  scopeKey = label,
  listRef,
  onVisibleRangeChange,
  rowAttributes,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  children: (item: T, index: number) => ReactNode;
  label: string;
  ordered?: boolean;
  threshold?: number;
  className?: string;
  bounded?: boolean;
  scopeKey?: string;
  rowAttributes?: (item: T) => RowAttributes;
  listRef?: Ref<WindowedRecordListHandle>;
  onVisibleRangeChange?: (range: ListRange) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const virtual = useRef<VirtuosoHandle>(null);
  const [pendingFocus, setPendingFocus] = useState<FocusRequest | null>(null);
  const requestedFocus = useRef<FocusRequest | null>(null);
  const focusedControl = useRef<FocusedControl | null>(null);
  const cancelRequestedFocus = useCallback(() => {
    requestedFocus.current = null;
    focusedControl.current = null;
    setPendingFocus(null);
  }, []);
  const [range, setRange] = useState<ListRange>({ startIndex: 0, endIndex: -1 });
  const windowed = items.length > threshold;
  const {
    Virtuoso,
    virtualized,
    initialIndex,
    rangeChanged: viewportRangeChanged,
    failure,
    retry,
    scopeOwner,
    isCurrent,
  } = useDeferredVirtuoso({ needed: windowed, host, attribute: "data-record-key", keys: items.map(itemKey), scopeKey });
  const focusRecord = useCallback(
    (key: string, selector = "button:not(:disabled), a[href], [tabindex='0']") => {
      if (!isCurrent()) return;
      const index = items.findIndex((item) => itemKey(item) === key);
      if (index < 0) return;
      const request = { key, selector, owner: scopeOwner, origin: document.activeElement };
      requestedFocus.current = request;
      focusedControl.current = null;
      setPendingFocus(request);
      if (windowed) virtual.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
    },
    [items, itemKey, windowed, scopeOwner, isCurrent],
  );
  useImperativeHandle(listRef, () => ({ focusRecord }), [focusRecord]);
  // Read the latest committed records without re-centering a retained focus intent
  // whenever a caller supplies a fresh array or key callback for the same rows.
  const currentRecords = useRef({ items, itemKey });
  useLayoutEffect(() => {
    currentRecords.current = { items, itemKey };
  }, [items, itemKey]);
  useLayoutEffect(() => {
    if (!pendingFocus || !virtualized) return;
    if (pendingFocus.owner !== scopeOwner || !isCurrent()) {
      setPendingFocus(null);
      return;
    }
    const records = currentRecords.current;
    const index = records.items.findIndex((item) => records.itemKey(item) === pendingFocus.key);
    if (index >= 0) virtual.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
  }, [pendingFocus, virtualized, scopeOwner, isCurrent]);
  const restoreRequestedFocus = useCallback(() => {
    const request = requestedFocus.current;
    if (!request) return;
    if (request.owner !== scopeOwner || !isCurrent() || !items.some((item) => itemKey(item) === request.key)) {
      cancelRequestedFocus();
      return;
    }
    const previous = focusedControl.current;
    if (
      !previous &&
      document.activeElement !== request.origin &&
      !(
        document.activeElement === document.body &&
        (!request.origin || request.origin === document.body || !request.origin.isConnected)
      )
    ) {
      cancelRequestedFocus();
      return;
    }
    if (previous && (previous.element.isConnected || document.activeElement !== document.body)) {
      if (document.activeElement !== previous.element) cancelRequestedFocus();
      return;
    }
    const row = [...(host.current?.querySelectorAll<HTMLElement>("[data-record-key]") ?? [])].find(
      (element) => element.dataset.recordKey === request.key,
    );
    const target = row?.querySelector<HTMLElement>(request.selector);
    if (!target) return;
    // A measured range may replace the focused DOM node. Recover only the same
    // control, after removal left focus on body, with the original current owner.
    if (previous && !matchesControl(target, previous)) {
      cancelRequestedFocus();
      return;
    }
    if (bounded && !windowed) target.scrollIntoView({ block: "nearest", behavior: "auto" });
    focusedControl.current = controlIdentity(target);
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) focusedControl.current = previous;
    else if (!virtualized) cancelRequestedFocus();
  }, [items, itemKey, virtualized, bounded, windowed, scopeOwner, isCurrent, cancelRequestedFocus]);
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const element = host.current;
    if (!element) return;
    const observer = new MutationObserver(restoreRequestedFocus);
    observer.observe(element, { childList: true, subtree: true });
    const onFocus = (event: FocusEvent) => {
      if (event.target !== focusedControl.current?.element) cancelRequestedFocus();
    };
    // Explicit operator intent cancels recovery before a later DOM replacement.
    // A new record-navigation key creates its own request in the list handler.
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", cancelRequestedFocus, true);
    document.addEventListener("wheel", cancelRequestedFocus, { capture: true, passive: true });
    document.addEventListener("keydown", cancelRequestedFocus, true);
    document.addEventListener("click", cancelRequestedFocus, true);
    restoreRequestedFocus();
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("pointerdown", cancelRequestedFocus, true);
      document.removeEventListener("wheel", cancelRequestedFocus, true);
      document.removeEventListener("keydown", cancelRequestedFocus, true);
      document.removeEventListener("click", cancelRequestedFocus, true);
    };
  }, [pendingFocus, restoreRequestedFocus, cancelRequestedFocus]);
  useLayoutEffect(restoreRequestedFocus, [range, restoreRequestedFocus]);
  useEffect(() => {
    if (!windowed) onVisibleRangeChange?.({ startIndex: 0, endIndex: items.length - 1 });
  }, [windowed, items.length, onVisibleRangeChange]);
  const rangeChanged = useCallback(
    (next: ListRange) => {
      setRange(next);
      viewportRangeChanged();
      onVisibleRangeChange?.(next);
    },
    [onVisibleRangeChange, viewportRangeChanged],
  );
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !(event.target instanceof HTMLElement) ||
      event.target.closest("input,textarea,select,[contenteditable='true']")
    )
      return;
    const key = event.target.closest<HTMLElement>("[data-record-key]")?.dataset.recordKey;
    const index = items.findIndex((item) => itemKey(item) === key);
    if (index < 0) return;
    const next =
      event.key === "ArrowDown"
        ? Math.min(items.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    focusRecord(itemKey(items[next]!));
  }
  const renderedItems = windowed && !virtualized ? items.slice(0, Math.max(1, threshold)) : items;
  const render = (item: T, index: number) => (
    <div data-record-key={itemKey(item)} className="pb-2">
      {children(item, index)}
    </div>
  );
  return (
    <div
      ref={host}
      onKeyDown={onKeyDown}
      className={windowed || bounded ? `${className}${!virtualized ? " overflow-y-auto" : ""}` : undefined}
    >
      {virtualized && Virtuoso ? (
        <Virtuoso<T, ListContext>
          ref={virtual}
          data={[...items]}
          className="h-full w-full"
          initialTopMostItemIndex={initialIndex ?? 0}
          initialItemCount={Math.min(items.length, 1)}
          context={{
            label,
            ordered,
            total: items.length,
            attributes: (index: number) => (items[index] ? (rowAttributes?.(items[index]!) ?? {}) : {}),
          }}
          components={COMPONENTS}
          rangeChanged={rangeChanged}
          computeItemKey={(_index, item) => itemKey(item)}
          itemContent={(index, item) => render(item, index)}
        />
      ) : (
        createElement(
          ordered ? "ol" : "ul",
          { "aria-label": label },
          renderedItems.map((item, index) => (
            <li key={itemKey(item)} {...rowAttributes?.(item)} aria-setsize={items.length} aria-posinset={index + 1}>
              {render(item, index)}
            </li>
          )),
        )
      )}
      {windowed && !virtualized ? (
        failure ? (
          <p role="alert" className="p-2 text-sm text-fg-muted">
            {"More records could not be shown. The visible records are still available. "}
            <button type="button" onClick={retry} className="text-accent underline">
              Try again
            </button>
            {" · "}
            <button
              type="button"
              disabled={hasUnsettledChatContextMutation()}
              title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
              onClick={() => {
                if (!hasUnsettledChatContextMutation()) window.location.reload();
              }}
              className="text-accent underline"
            >
              Reload app
            </button>
          </p>
        ) : (
          <p role="status" className="p-2 text-sm text-fg-muted">
            Loading {items.length} records…
          </p>
        )
      ) : null}
    </div>
  );
}
