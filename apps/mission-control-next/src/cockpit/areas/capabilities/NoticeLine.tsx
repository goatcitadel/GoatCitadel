import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/** One plain line of caution above a list: a source that failed, or a recheck that did. Not announced. */
export function NoticeLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-fg-secondary">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-waiting" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}
