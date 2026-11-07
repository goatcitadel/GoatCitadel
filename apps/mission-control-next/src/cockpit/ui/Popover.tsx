import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type Ref,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import type { Popover as PopoverPrimitive } from "radix-ui";
import { useDeferredOverlay } from "./deferred-overlay-owner";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

type Runtime = typeof import("./PopoverRuntime");
let popoverLoad: Promise<Runtime> | undefined;
const loadPopover = () =>
  (popoverLoad ??= import("./PopoverRuntime").catch((cause) => {
    popoverLoad = undefined;
    throw cause;
  }));
type PopoverProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Root> & { scopeKey?: string };
type State = ReturnType<typeof useDeferredOverlay<Runtime>>;
const PopoverContext = createContext<State | null>(null);
function usePopover() {
  const state = useContext(PopoverContext);
  if (!state) throw new Error("Popover primitives require Popover");
  return state;
}
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}
export function Popover({ scopeKey = "", children, open, defaultOpen, onOpenChange, ...rootProps }: PopoverProps) {
  const state = useDeferredOverlay({ scopeKey, load: loadPopover, open, defaultOpen, onOpenChange });
  const reloadCancel = useRef<HTMLButtonElement>(null);
  const RuntimeRoot = state.runtime?.Root;
  useLayoutEffect(() => {
    if (!state.loading && !state.failure) return;
    const trigger = state.trigger.current,
      status = state.status.current;
    if (!trigger || !status) return;
    // Keep the pressed trigger and its sibling controls in place. The status
    // stays in DOM focus order while escaping clipped conversation scrollers.
    const position = () => {
      if (!trigger.isConnected || !status.isConnected) return;
      const anchor = trigger.getBoundingClientRect(),
        popup = status.getBoundingClientRect();
      const margin = 8,
        gap = 4,
        width = window.innerWidth,
        height = window.innerHeight;
      const left = Math.max(margin, Math.min(anchor.right - popup.width, width - popup.width - margin));
      const below = height - anchor.bottom - margin - gap,
        above = anchor.top - margin - gap;
      const top = below >= popup.height || below >= above ? anchor.bottom + gap : anchor.top - popup.height - gap;
      status.style.left = left + "px";
      status.style.top = Math.max(margin, Math.min(top, height - popup.height - margin)) + "px";
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(trigger);
    observer?.observe(status);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer?.disconnect();
    };
  }, [state.loading, state.failure, state.trigger, state.status]);
  return (
    <PopoverContext.Provider value={state}>
      {RuntimeRoot ? (
        <RuntimeRoot {...rootProps} open={state.open} onOpenChange={(next) => state.request(next)}>
          {children}
        </RuntimeRoot>
      ) : (
        children
      )}
      {state.loading || state.failure ? (
        <span
          ref={state.status}
          className="fixed z-60 w-max cockpit-menu-status-viewport overflow-auto rounded-md border border-line bg-overlay p-2 text-xs text-fg-muted shadow-overlay"
          role="status"
        >
          {state.failure ? (
            <>
              {"Panel controls could not load. "}
              <Button
                size="sm"
                className="cockpit-deferred-recovery-control min-h-8 max-sm:min-h-11"
                onClick={(event) => state.requestReload(event.currentTarget)}
              >
                Reload app
              </Button>
            </>
          ) : (
            "Loading panel controls…"
          )}{" "}
          <button
            type="button"
            className="cockpit-deferred-recovery-control min-h-8 px-2 max-sm:min-h-11"
            onClick={() => state.close(true)}
          >
            Cancel panel
          </button>
        </span>
      ) : null}
      <Dialog
        open={Boolean(state.reloadReview && state.reloadCurrent(state.reloadReview))}
        onOpenChange={(open) => {
          if (!open) state.cancelReload(state.reloadReview);
        }}
        title="Reload app?"
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (state.reloadReview && state.reloadCurrent(state.reloadReview))
            reloadCancel.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          state.restoreReloadFocus();
        }}
      >
        <div ref={state.registerRecoveryHost} className="flex justify-end gap-2">
          <Button ref={reloadCancel} onClick={() => state.cancelReload(state.reloadReview)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!state.reloadReview || !state.reloadCurrent(state.reloadReview)}
            onClick={() => state.confirmReload(state.reloadReview)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </PopoverContext.Provider>
  );
}
export const PopoverTrigger = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(function PopoverTrigger(props, forwardedRef) {
  const state = usePopover();
  const bind = (element: HTMLButtonElement | null) => {
    state.trigger.current = element;
    assignRef(forwardedRef, element);
  };
  const RuntimeTrigger = state.runtime?.Trigger;
  const { open, runtime, close, cancel } = state;
  useLayoutEffect(() => {
    if (props.disabled && open) {
      if (runtime) close(false);
      else cancel(false);
    }
  }, [props.disabled, open, runtime, close, cancel]);
  if (RuntimeTrigger) return <RuntimeTrigger {...props} ref={bind} />;
  const { asChild, onPointerDown, onKeyDown, onClick, ...rest } = props;
  const Trigger = asChild ? Slot : "button";
  return (
    <Trigger
      type="button"
      aria-haspopup="dialog"
      aria-expanded={state.open}
      data-state={state.open ? "open" : "closed"}
      data-disabled={props.disabled ? "" : undefined}
      {...rest}
      ref={bind}
      aria-busy={state.loading || undefined}
      onPointerDown={(event) => {
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || props.disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          state.request(!state.open, "keyboard");
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || props.disabled) return;
        event.currentTarget.focus({ preventScroll: true });
        state.request(!state.open, "pointer");
      }}
    />
  );
});
export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ onCloseAutoFocus, onInteractOutside, ...props }, forwardedRef) {
  const state = usePopover(),
    RuntimeContent = state.runtime?.Content;
  if (!RuntimeContent) return null;
  return (
    <RuntimeContent
      {...props}
      ref={(element) => {
        state.content.current = element;
        assignRef(forwardedRef, element);
      }}
      onInteractOutside={(event) => {
        onInteractOutside?.(event);
        if (!event.defaultPrevented && state.intent.current) state.intent.current.restore = false;
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        const ticket = state.intent.current;
        if (!ticket || !state.isCurrent(ticket.owner) || !ticket.restore || !state.ownsFocus(ticket))
          event.preventDefault();
      }}
    />
  );
});
