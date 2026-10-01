import type { ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-line-subtle", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(
    "border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary data-[state=active]:border-accent data-[state=active]:text-fg",
    className,
  )} {...props} />;
}
