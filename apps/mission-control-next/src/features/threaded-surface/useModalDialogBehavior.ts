import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/*
 * Modal dialog behavior for hand-rolled overlays (sheets, drawers) that are
 * not built on a dialog primitive: Escape closes, Tab is trapped inside the
 * container, focus moves into the dialog on open and returns to the trigger
 * on close, and body scroll is locked while open.
 *
 * No-ops outside a DOM (vitest node environment, SSR).
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface ModalDialogBehaviorInput {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
}

function asFocusable(value: Element | null): HTMLElement | null {
  return value && typeof (value as HTMLElement).focus === "function" ? (value as HTMLElement) : null;
}

export function useModalDialogBehavior({ open, onClose, containerRef }: ModalDialogBehaviorInput): void {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }
    const previouslyFocused = asFocusable(document.activeElement);
    const listFocusable = (): HTMLElement[] => {
      const container = containerRef.current;
      return container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const closed = element.closest("details:not([open])");
        return !closed || (element.tagName === "SUMMARY" && element.parentElement === closed);
      }) : [];
    };

    listFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      // A confirmation or picker opened above this sheet owns its own keys.
      const activeDialog = document.activeElement?.closest('[role="dialog"][aria-modal="true"]');
      if (activeDialog && activeDialog !== containerRef.current && !containerRef.current?.contains(activeDialog)) return;
      if (event.key === "Escape") {
        /*
         * Capture-phase stopPropagation scopes Escape to this modal layer:
         * bubble-phase listeners (more-menu, panel-switcher dropdowns) must
         * not also close while the modal sits on top. Next press reaches them.
         */
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = listFocusable();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }
      const active = document.activeElement;
      const containerHoldsFocus = Boolean(active && containerRef.current?.contains(active));
      if (event.shiftKey) {
        if (!containerHoldsFocus || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!containerHoldsFocus || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);

    const { body } = document;
    const inertSiblings: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement | null = containerRef.current;
    while (branch && branch !== body) {
      const parent: HTMLElement | null = branch.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
        inertSiblings.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = parent;
    }
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      body.style.overflow = previousOverflow;
      for (const { element, inert } of inertSiblings) element.inert = inert;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [containerRef, open]);
}
