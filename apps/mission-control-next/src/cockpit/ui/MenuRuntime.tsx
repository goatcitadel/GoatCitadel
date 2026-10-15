import { DropdownMenu } from "radix-ui";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { cn } from "../lib/cn";
export const Root = DropdownMenu.Root;
export const Trigger = DropdownMenu.Trigger;
export const Content = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(function Content({ className, ...props }, ref) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        sideOffset={6}
        className={cn("z-60 min-w-48 rounded-md border border-line bg-overlay p-1 shadow-overlay", className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
});
export const Item = forwardRef<
  ComponentRef<typeof DropdownMenu.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Item>
>(function Item({ className, ...props }, ref) {
  return (
    <DropdownMenu.Item
      ref={ref}
      className={cn(
        "cockpit-menu-item flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-sunken",
        className,
      )}
      {...props}
    />
  );
});
