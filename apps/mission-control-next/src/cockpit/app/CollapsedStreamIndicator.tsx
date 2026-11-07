import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "../ui/Tooltip";

export function CollapsedStreamIndicator({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Tooltip label={label}>
      <span tabIndex={0} role="img" aria-label={label} className="inline-flex rounded-sm">{children}</span>
    </Tooltip>
  );
}