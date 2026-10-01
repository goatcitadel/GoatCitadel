import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border border-line px-1 font-mono text-xs text-fg-muted">{children}</kbd>;
}
