import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
export const Root = PopoverPrimitive.Root;
export const Trigger = PopoverPrimitive.Trigger;
export const Content = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function Content({ className, ...props }, ref) {
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
      />
    </PopoverPrimitive.Portal>
  );
});
