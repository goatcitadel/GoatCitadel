import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type Ref,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import type { Popover as PopoverPrimitive } from "radix-ui";
import { useDeferredOverlay } from "./deferred-overlay-owner";
import { DeferredOverlayStatus } from "./DeferredOverlayStatus";

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
  const RuntimeRoot = state.runtime?.Root;
  return (
    <PopoverContext.Provider value={state}>
      {RuntimeRoot ? (
        <RuntimeRoot {...rootProps} open={state.open} onOpenChange={(next) => state.request(next)}>
          {children}
        </RuntimeRoot>
      ) : (
        children
      )}
      <DeferredOverlayStatus state={state} name="Panel" />
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
