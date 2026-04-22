import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface GCEmptyStateProps {
  title: string;
  description?: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  compact?: boolean;
  className?: string;
  subtitle?: string;
  action?: ReactNode;
}

export function GCEmptyState({
  title,
  description,
  primaryAction,
  secondaryAction,
  icon,
  meta,
  compact = true,
  className,
  subtitle,
  action,
}: GCEmptyStateProps) {
  const resolvedDescription = description ?? subtitle;
  const resolvedPrimaryAction = primaryAction ?? action;

  return (
    <section className={cn("gc-empty-state mc-gc-empty-state", compact && "gc-empty-state-compact", className)}>
      {icon ? <div className="gc-empty-icon">{icon}</div> : null}
      <div className="gc-empty-copy">
        <h3 className="gc-empty-title">{title}</h3>
        {resolvedDescription ? <p className="gc-empty-subtitle">{resolvedDescription}</p> : null}
      </div>
      {resolvedPrimaryAction || secondaryAction || meta ? (
        <div className="gc-empty-action">
          {resolvedPrimaryAction ? <div className="gc-empty-primary-action">{resolvedPrimaryAction}</div> : null}
          {secondaryAction ? <div className="gc-empty-secondary-action">{secondaryAction}</div> : null}
          {meta ? <div className="gc-empty-meta">{meta}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
