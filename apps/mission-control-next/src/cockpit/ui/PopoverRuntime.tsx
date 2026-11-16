import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
import { NoFocusTooltips } from "./tooltip-focus";
export const Root = PopoverPrimitive.Root;
export const Trigger = PopoverPrimitive.Trigger;
export const Content = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function Content({ className, children, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          "z-60 w-72 max-w-full rounded-md border border-line bg-overlay p-2 text-fg shadow-overlay",
          className,
        )}
        {...props}
      >
        <NoFocusTooltips>{children}</NoFocusTooltips>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
});
