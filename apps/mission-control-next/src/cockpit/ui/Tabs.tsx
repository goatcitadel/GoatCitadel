import type { ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
import { TAB_ACTIVE_CLASS, TAB_CLASS } from "./tab-style";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-line-subtle", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(TAB_CLASS, TAB_ACTIVE_CLASS, className)} {...props} />;
}
