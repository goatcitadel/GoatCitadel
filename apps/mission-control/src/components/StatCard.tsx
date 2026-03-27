import type { ReactNode } from "react";

type StatTone = "default" | "accent" | "warning" | "success";

interface StatCardProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: StatTone;
  className?: string;
  compact?: boolean;
  interactive?: boolean;
  onClick?: () => void;
}

export function StatCard({
  label,
  value,
  note,
  tone = "default",
  className,
  compact = false,
  interactive = false,
  onClick,
}: StatCardProps) {
  const Element = interactive ? "button" : "article";
  return (
    <Element
      type={interactive ? "button" : undefined}
      className={`stat-card stat-card-${tone}${compact ? " stat-card-compact" : ""}${interactive ? " stat-card-interactive" : ""}${className ? ` ${className}` : ""}`}
      onClick={interactive ? onClick : undefined}
    >
      <p className="stat-card-label">{label}</p>
      <p className="stat-card-value">{value}</p>
      {note ? <p className="stat-card-note">{note}</p> : null}
    </Element>
  );
}
