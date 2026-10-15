import { cn } from "../lib/cn";

// Static on purpose: DESIGN.md reserves the pulse for live runs, so a loading placeholder must not look like one.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded-md bg-sunken", className)} />;
}
