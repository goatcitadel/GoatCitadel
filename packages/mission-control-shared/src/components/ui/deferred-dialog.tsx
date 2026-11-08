import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type DeferredRuntime<T> = { read: () => T | undefined; load: () => Promise<T> };
export type DialogFocusHandler = (event: Event) => void;

export function createDeferredDialogRuntime<T>(importRuntime: () => Promise<T>): DeferredRuntime<T> {
  let runtime: T | undefined;
  let loading: Promise<T> | undefined;
  return {
    read: () => runtime,
    load: () =>
      (loading ??= importRuntime().then(
        (loaded) => (runtime = loaded),
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      )),
  };
}

export function useDeferredDialogRuntime<T>(open: boolean, loader: DeferredRuntime<T>) {
  const [failed, setFailed] = useState(false);
  const [, render] = useState(0);
  const runtime = loader.read();
  useEffect(() => {
    if (!open || runtime) return;
    let current = true;
    setFailed(false);
    void loader.load().then(
      () => {
        if (current) render((revision) => revision + 1);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [loader, open, runtime]);
  return { runtime, failed };
}

/** Native modality protects the loading state while the dialog's actual controls are unavailable. */
export function PendingDialog({
  title,
  description,
  closeLabel,
  className,
  dismissDisabled = false,
  onDismiss,
  onOpenAutoFocus,
  onCloseAutoFocus,
  handoff,
  keepFocusForHandoff = false,
  container,
  children,
}: {
  title: string;
  description?: string;
  closeLabel: string;
  className: string;
  dismissDisabled?: boolean;
  onDismiss: () => void;
  onOpenAutoFocus?: DialogFocusHandler;
  onCloseAutoFocus?: DialogFocusHandler;
  handoff: RefObject<boolean>;
  keepFocusForHandoff?: boolean;
  container?: HTMLElement | null;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const openFocus = useRef(onOpenAutoFocus);
  openFocus.current = onOpenAutoFocus;
  const closeFocus = useRef(onCloseAutoFocus);
  closeFocus.current = onCloseAutoFocus;
  const dismiss = useRef({ dismissDisabled, onDismiss });
  dismiss.current = { dismissDisabled, onDismiss };
  const isHandingOff = useEffectEvent(() => handoff.current);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const handleOpenFocus = openFocus.current;
    if (handleOpenFocus) {
      dialog.addEventListener("dialog.openAutoFocus", handleOpenFocus, { once: true });
      dialog.dispatchEvent(new Event("dialog.openAutoFocus", { cancelable: true }));
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.activeElement?.closest('[role="dialog"]') !== dialog) return;
      // An underlying overlay must not interpret Escape owned by the top-layer dialog.
      event.preventDefault();
      event.stopPropagation();
      if (!dismiss.current.dismissDisabled) dismiss.current.onDismiss();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
      // Sheet tracks the pending panel's focus until the pending DOM is detached.
      // Closing first would redirect that focus to the underlying trigger.
      if (isHandingOff() && keepFocusForHandoff) return;
      const active = document.activeElement;
      const ownedFocus = active === document.body || dialog.contains(active);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      // Strict Mode can tear down and repeat the effect while the same dialog remains mounted.
      if (dialog.isConnected) return;
      if (isHandingOff()) {
        // The ready dialog must record the original opener, not the removed loading button.
        if (ownedFocus && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
      } else if (closeFocus.current) {
        closeFocus.current(new Event("dialog.closeAutoFocus", { cancelable: true }));
      } else if (ownedFocus && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [keepFocusForHandoff]);

  if (typeof document === "undefined" || !document.body) return null;
  return createPortal(
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-state="open"
      className={className}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (!dismissDisabled) onDismiss();
      }}
    >
      <h2 id={titleId} className="font-semibold">
        {title}
      </h2>
      {description ? <p id={descriptionId}>{description}</p> : null}
      {children}
      <button
        type="button"
        aria-label={closeLabel}
        className="mt-3 rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        disabled={dismissDisabled}
        onClick={(event) => {
          if (!event.defaultPrevented) onDismiss();
        }}
      >
        {closeLabel}
      </button>
    </dialog>,
    container ?? document.body,
  );
}
