import { cn } from "../lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse-live rounded-md bg-sunken", className)} />;
}
