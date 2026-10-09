import type { ComponentPropsWithoutRef } from "react";
import { DropdownMenu } from "radix-ui";
import { cn } from "../lib/cn";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return <DropdownMenu.Portal>
    <DropdownMenu.Content sideOffset={6} className={cn(
      "z-50 min-w-48 rounded-md border border-line bg-overlay p-1 shadow-overlay", className,
    )} {...props} />
  </DropdownMenu.Portal>;
}

export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn(
    "cockpit-menu-item flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-sunken",
    className,
  )} {...props} />;
}
