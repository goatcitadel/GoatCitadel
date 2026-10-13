import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision, subscribeGatewayAccessChange, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";

type VirtuosoComponent = typeof import("react-virtuoso").Virtuoso;
// The code module is scope-neutral; each viewport fences its own completion.
// Reuse an in-flight load across mounts and owner changes, then allow retry after failure.
let virtuosoLoad: Promise<{ Virtuoso: VirtuosoComponent }> | undefined;
function loadVirtuoso() {
  virtuosoLoad ??= import("react-virtuoso").catch(cause => { virtuosoLoad = undefined; throw cause; });
  return virtuosoLoad;
}
type ElementState = { path: number[]; tag: string; label: string | null; text: string | null };
type ViewportState = {
  top: number;
  anchor?: { key: string; offset: number };
  focus?: { key: string; element: ElementState };
  disclosures: { key: string; element: ElementState; open: boolean }[];
};
function elementState(element: HTMLElement, row: HTMLElement): ElementState {
  const path: number[] = [];
  let child: Element | null = element;
  while (child && child !== row) {
    const parent: Element | null = child.parentElement;
    if (!parent) break;
    path.unshift([...parent.children].indexOf(child)); child = parent;
  }
  const label = element.getAttribute("aria-label") ?? (element.tagName === "SUMMARY" ? element.parentElement?.getAttribute("aria-label") ?? null : null);
  const text = label && (element.tagName === "DETAILS" || element.tagName === "SUMMARY") ? null : element.textContent;
  return { path, tag: element.tagName, label, text };
}
function matchingElement(row: HTMLElement, state: ElementState): HTMLElement | undefined {
  let element: Element | undefined = row;
  for (const index of state.path) element = element?.children[index];
  if (!(element instanceof HTMLElement) || element.tagName !== state.tag) return;
  const label = element.getAttribute("aria-label") ?? (element.tagName === "SUMMARY" ? element.parentElement?.getAttribute("aria-label") ?? null : null);
  return label === state.label && (state.text === null || element.textContent === state.text) ? element : undefined;
}
function scrollerFor(host: HTMLElement): HTMLElement {
  if (host.hasAttribute("data-transcript-scroller")) return host;
  return host.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]') ?? host;
}
function captureViewport(host: HTMLElement | null, attribute: string): ViewportState | null {
  if (!host) return null;
  const scroller = scrollerFor(host), bounds = scroller.getBoundingClientRect();
  const rows = [...host.querySelectorAll<HTMLElement>(`[${attribute}]`)];
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
  const focusedRow = focused?.closest<HTMLElement>(`[${attribute}]`);
  const anchor = focusedRow ?? rows.find(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom);
  return {
    top: scroller.scrollTop,
    ...(anchor ? { anchor: { key: anchor.getAttribute(attribute)!, offset: anchor.getBoundingClientRect().top - bounds.top } } : {}),
    ...(focused && focusedRow ? { focus: { key: focusedRow.getAttribute(attribute)!, element: elementState(focused, focusedRow) } } : {}),
    disclosures: rows.flatMap(row => [...row.querySelectorAll<HTMLDetailsElement>("details")].map(element => ({ key: row.getAttribute(attribute)!, element: elementState(element, row), open: element.open }))),
  };
}
/** Load only when a bounded list needs windowing; retain presentation through that one viewport transition. */
export function useDeferredVirtuoso({ needed, host, attribute, keys, scopeKey }: {
  needed: boolean; host: RefObject<HTMLElement | null>; attribute: "data-record-key" | "data-turn-id"; keys: readonly string[]; scopeKey: string;
}) {
  const callerRevision = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, getGatewayCallerScopeRevision);
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const gateway = getGatewayApiBaseUrl();
  const scope = JSON.stringify([gateway, callerRevision, accessRevision, scopeKey]);
  const scopeOwner = useMemo(() => ({ scope }), [scope]);
  const committedOwner = useRef(scopeOwner);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = useCallback(() => mounted.current && committedOwner.current === scopeOwner && getGatewayApiBaseUrl() === gateway
    && getGatewayCallerScopeRevision() === callerRevision && getGatewayAccessRevision() === accessRevision, [scopeOwner, gateway, callerRevision, accessRevision]);
  const [Virtuoso, setVirtuoso] = useState<VirtuosoComponent | null>(null);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [virtualized, setVirtualized] = useState(false);
  const [initialKey, setInitialKey] = useState<string>();
  const [rangeVersion, setRangeVersion] = useState(0);
  const snapshot = useRef<{ owner: object; state: ViewportState } | null>(null);
  useLayoutEffect(() => {
    if (committedOwner.current === scopeOwner) return;
    committedOwner.current = scopeOwner; snapshot.current = null;
    setVirtualized(false); setInitialKey(undefined); setFailure(false);
  }, [scopeOwner]);
  useEffect(() => {
    let current = true;
    const owned = () => current && isCurrent();
    const changeViewport = (next: boolean) => {
      if (!owned()) return;
      const state = captureViewport(host.current, attribute);
      snapshot.current = state ? { owner: scopeOwner, state } : null;
      setInitialKey(next ? state?.anchor?.key : undefined); setVirtualized(next);
    };
    if (!needed) {
      if (virtualized) changeViewport(false);
    } else if (!virtualized && !failure) {
      if (Virtuoso) changeViewport(true);
      else void loadVirtuoso().then(module => {
        if (!owned()) return;
        setVirtuoso(() => module.Virtuoso); changeViewport(true);
      }, () => { if (owned()) setFailure(true); });
    }
    return () => { current = false; };
  }, [needed, virtualized, Virtuoso, failure, attempt, scope, gateway, callerRevision, accessRevision, host, attribute, scopeOwner, isCurrent]);
  useLayoutEffect(() => {
    const saved = snapshot.current, element = host.current;
    if (!saved || !element) return;
    if (saved.owner !== scopeOwner || !isCurrent()) { snapshot.current = null; return; }
    const state = saved.state;
    const rows = [...element.querySelectorAll<HTMLElement>(`[${attribute}]`)];
    const byKey = (key: string) => rows.find(row => row.getAttribute(attribute) === key);
    const scroller = scrollerFor(element);
    const anchor = state.anchor ? byKey(state.anchor.key) : undefined;
    if (state.anchor && keys.includes(state.anchor.key) && !anchor) return;
    for (const disclosure of state.disclosures) {
      const row = byKey(disclosure.key), target = row ? matchingElement(row, disclosure.element) : undefined;
      if (target instanceof HTMLDetailsElement) target.open = disclosure.open;
    }
    if (anchor && state.anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - state.anchor.offset;
    else scroller.scrollTop = state.top;
    if (state.focus && (document.activeElement === document.body || element.contains(document.activeElement))) {
      const row = byKey(state.focus.key), target = row ? matchingElement(row, state.focus.element) : undefined;
      target?.focus({ preventScroll: true });
    }
    snapshot.current = null;
  }, [virtualized, rangeVersion, host, attribute, keys, scope, gateway, callerRevision, accessRevision]);
  const rangeChanged = useCallback(() => setRangeVersion(value => value + 1), []);
  const retry = useCallback(() => { setFailure(false); setAttempt(value => value + 1); }, []);
  const initialIndex = initialKey ? keys.indexOf(initialKey) : -1;
  return { Virtuoso, virtualized, initialIndex: initialIndex >= 0 ? initialIndex : undefined, rangeChanged, failure, retry, scopeOwner, isCurrent };
}
