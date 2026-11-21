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
import type { DropdownMenu } from "radix-ui";
import { useDeferredOverlay } from "./deferred-overlay-owner";
import { DeferredOverlayStatus } from "./DeferredOverlayStatus";

type Runtime = typeof import("./MenuRuntime");
let menuLoad: Promise<Runtime> | undefined;
const loadMenu = () =>
  (menuLoad ??= import("./MenuRuntime").catch((cause) => {
    menuLoad = undefined;
    throw cause;
  }));
type MenuProps = ComponentPropsWithoutRef<typeof DropdownMenu.Root> & { scopeKey?: string };
type State = ReturnType<typeof useDeferredOverlay<Runtime>>;
const MenuContext = createContext<State | null>(null);
function useMenu() {
  const state = useContext(MenuContext);
  if (!state) throw new Error("Menu primitives require Menu");
  return state;
}
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}
export function Menu({ scopeKey = "", children, open, defaultOpen, onOpenChange, ...rootProps }: MenuProps) {
  const state = useDeferredOverlay({ scopeKey, load: loadMenu, open, defaultOpen, onOpenChange });
  const RuntimeRoot = state.runtime?.Root;
  return (
    <MenuContext.Provider value={state}>
      {RuntimeRoot ? (
        <RuntimeRoot {...rootProps} open={state.open} onOpenChange={(next) => state.request(next)}>
          {children}
        </RuntimeRoot>
      ) : (
        children
      )}
      <DeferredOverlayStatus state={state} name="Menu" />
    </MenuContext.Provider>
  );
}
export const MenuTrigger = forwardRef<
  ComponentRef<typeof DropdownMenu.Trigger>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Trigger>
>(function MenuTrigger(props, forwardedRef) {
  const state = useMenu();
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
      aria-haspopup="menu"
      aria-expanded={state.open}
      data-state={state.open ? "open" : "closed"}
      data-disabled={props.disabled ? "" : undefined}
      {...rest}
      ref={bind}
      aria-busy={state.loading || undefined}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || props.disabled || event.button !== 0 || event.ctrlKey) return;
        if (state.open) state.close(true);
        else {
          event.currentTarget.focus({ preventScroll: true });
          state.request(true, "pointer", true);
          event.preventDefault();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || props.disabled) return;
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
          state.request(event.key === "ArrowDown" || !state.open, "keyboard");
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        onClick?.(event);
        state.finishPointer();
      }}
    />
  );
});
export const MenuContent = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(function MenuContent({ onFocus, onCloseAutoFocus, onInteractOutside, ...props }, forwardedRef) {
  const state = useMenu(),
    RuntimeContent = state.runtime?.Content;
  if (!RuntimeContent) return null;
  return (
    <RuntimeContent
      {...props}
      ref={(element) => {
        state.content.current = element;
        assignRef(forwardedRef, element);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (
          event.defaultPrevented ||
          event.target !== event.currentTarget ||
          document.activeElement !== event.currentTarget
        )
          return;
        const ticket = state.intent.current;
        // The cold trigger handled its key before the public SDK Root existed. Its
        // normal mount focuses Content; restore only that exact owned keyboard entry.
        if (
          !ticket ||
          ticket.kind !== "keyboard" ||
          !state.isCurrent(ticket.owner) ||
          ticket.cancelled ||
          !state.ownsFocus(ticket)
        )
          return;
        event.preventDefault();
        for (const candidate of event.currentTarget.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([data-disabled])',
        )) {
          candidate.focus({ preventScroll: true });
          if (document.activeElement === candidate) break;
        }
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
export const MenuItem = forwardRef<
  ComponentRef<typeof DropdownMenu.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Item>
>(function MenuItem({ onSelect, ...props }, forwardedRef) {
  const state = useMenu(),
    RuntimeItem = state.runtime?.Item;
  if (!RuntimeItem) return null;
  return (
    <RuntimeItem
      {...props}
      ref={forwardedRef}
      onSelect={(event) => {
        if (!state.isCurrent() || !state.open) {
          event.preventDefault();
          return;
        }
        onSelect?.(event);
      }}
    />
  );
});
