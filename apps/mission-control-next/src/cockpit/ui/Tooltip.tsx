import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

const LONG_PRESS_MS = 500;

/**
 * Names a control on hover and keyboard focus (Radix), and on a touch long-press, which Radix does not handle.
 * The label is also shown to assistive technology through the tooltip's description.
 */
export function Tooltip({
  label,
  children,
  openOnFocus = true,
}: {
  label: string;
  children: ReactNode;
  /** False for a control that takes focus by itself (a dialog's close button): Escape must reach the dialog, not a tooltip. */
  openOnFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPress = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const startPress = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    cancelPress();
    timer.current = setTimeout(() => setOpen(true), LONG_PRESS_MS);
  };
  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger
          asChild
          onFocus={(event) => {
            if (!openOnFocus) event.preventDefault();
          }}
          onPointerDown={startPress}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-60 rounded-sm bg-overlay px-2 py-1 text-xs text-fg shadow-overlay"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
