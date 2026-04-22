import type { ReactNode } from "react";

type StatusTone = "default" | "live" | "warning" | "critical" | "success" | "muted";

interface StatusChipProps {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
}

export function StatusChip({ children, tone = "default", className }: StatusChipProps) {
  return <span className={`status-chip status-chip-${tone}${className ? ` ${className}` : ""}`}>{children}</span>;
}
