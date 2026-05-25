import type { ReactNode } from "react";

export type EmptyStateTone = "neutral" | "accent";
export type EmptyStateSize = "compact" | "default";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  tone?: EmptyStateTone;
  size?: EmptyStateSize;
};

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryActions,
  tone = "neutral",
  size = "default",
}: EmptyStateProps) {
  const hasActions = Boolean(primaryAction) || Boolean(secondaryActions);
  return (
    <div className="mc-next-empty-state" data-tone={tone} data-size={size} role="status">
      {icon !== undefined ? (
        <span className="mc-next-empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="mc-next-empty-state-copy">
        <h2 className="mc-next-empty-state-title">{title}</h2>
        {description !== undefined ? <p className="mc-next-empty-state-description">{description}</p> : null}
      </div>
      {hasActions ? (
        <div className="mc-next-empty-state-actions">
          {primaryAction !== undefined ? <div className="mc-next-empty-state-primary">{primaryAction}</div> : null}
          {secondaryActions !== undefined ? (
            <div className="mc-next-empty-state-secondary">{secondaryActions}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
