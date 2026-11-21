import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTooltipOpensOnFocus } from "./tooltip-focus";

const HOVER_MS = 400;
const LONG_PRESS_MS = 500;
const HOVER_EXIT_MS = 150;
const GAP = 6;
const VIEWPORT_INSET = 8;
const TOOLTIP_OPEN = "goatcitadel:tooltip-open";

/** The trigger stays mounted. Measure and position the label only while it is visible. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const openOnFocus = useTooltipOpensOnFocus();
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPending = () => {
    clearTimeout(pending.current);
    pending.current = undefined;
  };
  useEffect(() => () => clearTimeout(pending.current), []);
  const close = () => {
    cancelPending();
    setAnchor(null);
  };
  const openAfter = (element: HTMLElement, delay: number) => {
    if (pending.current !== undefined || anchor) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      if (element.isConnected) setAnchor(element);
    }, delay);
  };

  useLayoutEffect(() => {
    const trigger = anchor;
    const element = popup.current;
    if (!trigger || !element) return;
    const place = () => {
      if (!trigger.isConnected) {
        setAnchor(null);
        return;
      }
      const target = trigger.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const left = Math.max(
        VIEWPORT_INSET,
        Math.min(target.left + (target.width - width) / 2, window.innerWidth - width - VIEWPORT_INSET),
      );
      const below = target.bottom + GAP;
      const top =
        below + height <= window.innerHeight - VIEWPORT_INSET
          ? below
          : Math.max(VIEWPORT_INSET, target.top - height - GAP);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    const dismissOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.contains(event.target) && !element.contains(event.target))
        setAnchor(null);
    };
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setAnchor(null);
    }
    document.dispatchEvent(new Event(TOOLTIP_OPEN));
    const dismissForOtherTooltip = () => setAnchor(null);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismissOnPointer, true);
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener(TOOLTIP_OPEN, dismissForOtherTooltip);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismissOnPointer, true);
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener(TOOLTIP_OPEN, dismissForOtherTooltip);
    };
  }, [anchor, label]);

  if (!isValidElement<HTMLAttributes<HTMLElement>>(children)) return children;
  const props = children.props;
  const descriptive = props["aria-label"] !== label;
  const description = [props["aria-describedby"], anchor && descriptive ? id : undefined].filter(Boolean).join(" ");
  return (
    <>
      {cloneElement(children, {
        ...{ "data-state": anchor ? "open" : "closed" },
        "aria-describedby": description || undefined,
        onPointerMove(event) {
          props.onPointerMove?.(event);
          if (!event.defaultPrevented && event.pointerType !== "touch") openAfter(event.currentTarget, HOVER_MS);
        },
        onPointerLeave(event) {
          props.onPointerLeave?.(event);
          cancelPending();
          if (anchor && anchor !== document.activeElement) pending.current = setTimeout(close, HOVER_EXIT_MS);
        },
        onPointerDown(event) {
          props.onPointerDown?.(event);
          if (event.defaultPrevented) return;
          if (event.pointerType === "touch") {
            cancelPending();
            openAfter(event.currentTarget, LONG_PRESS_MS);
          } else close();
        },
        onPointerUp(event) {
          props.onPointerUp?.(event);
          cancelPending();
        },
        onPointerCancel(event) {
          props.onPointerCancel?.(event);
          close();
        },
        onFocus(event) {
          props.onFocus?.(event);
          if (!event.defaultPrevented && openOnFocus && event.currentTarget.matches(":focus-visible")) {
            cancelPending();
            setAnchor(event.currentTarget);
          }
        },
        onBlur(event) {
          props.onBlur?.(event);
          close();
        },
      })}
      {anchor &&
        createPortal(
          <span
            id={id}
            ref={popup}
            role="tooltip"
            onPointerEnter={cancelPending}
            onPointerLeave={(event) => {
              if (!(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) close();
            }}
            className="fixed z-60 max-w-tooltip break-words rounded-sm bg-overlay px-2 py-1 text-xs text-fg shadow-overlay"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
