import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../lib/cn";

/**
 * A small floating panel opened from a button, for a short list of choices that would crowd the page. Unlike `Menu`
 * it holds ordinary buttons and fields, and it loads with the page. The content has role dialog, so give it an
 * `aria-label`.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, ...props }, ref) {
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
