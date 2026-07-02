import type { ReactNode } from "react";

export type StatusChipTone = "success" | "warning" | "critical" | "muted" | "neutral" | "default" | "live";
export type StatusChipSize = "sm" | "md";

export type StatusChipProps = {
  tone: StatusChipTone;
  icon?: ReactNode;
  children: ReactNode;
  size?: StatusChipSize;
  title?: string;
  ariaLabel?: string;
};

export function StatusChip({ tone, icon, children, size = "sm", title, ariaLabel }: StatusChipProps) {
  return (
    <span
      className="mc-next-status-chip"
      data-tone={tone}
      data-size={size}
      title={title}
      aria-label={ariaLabel ?? title}
    >
      {icon !== undefined ? (
        <span className="mc-next-status-chip-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="mc-next-status-chip-label">{children}</span>
    </span>
  );
}
