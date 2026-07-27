import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

export type ErrorStateTone = "danger" | "caution";
export type ErrorStateSize = "inline" | "default";

export type ErrorStateProps = {
  /** Defaults to an AlertTriangle. Pass `null` to omit the icon. */
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Typically a Retry button wired to the route's reload(). */
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  /** Raw transport or protocol text, hidden behind an operator-opened disclosure. */
  technicalDetails?: ReactNode;
  tone?: ErrorStateTone;
  /** `inline` is a compact banner (drop-in for .mc-next-directory-alert);
   *  `default` is a full centred panel mirroring EmptyState. */
  size?: ErrorStateSize;
};

/**
 * The error counterpart to EmptyState: one consistent, themed error surface with
 * an optional retry, replacing the ad-hoc `.mc-next-directory-alert` banners.
 */
export function ErrorState({
  icon,
  title,
  description,
  primaryAction,
  secondaryActions,
  technicalDetails,
  tone = "danger",
  size = "inline",
}: ErrorStateProps) {
  const resolvedIcon = icon === undefined ? <AlertTriangle size={16} /> : icon;
  const hasActions = Boolean(primaryAction) || Boolean(secondaryActions);
  return (
    <div className="mc-next-error-state" data-tone={tone} data-size={size} role="alert">
      {resolvedIcon !== null ? (
        <span className="mc-next-error-state-icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      ) : null}
      <div className="mc-next-error-state-copy">
        {title !== undefined && title !== null ? <p className="mc-next-error-state-title">{title}</p> : null}
        {description !== undefined && description !== null ? (
          <p className="mc-next-error-state-description">{description}</p>
        ) : null}
        {technicalDetails !== undefined && technicalDetails !== null ? (
          <details className="mc-next-error-state-details">
            <summary>Technical details</summary>
            <code>{technicalDetails}</code>
          </details>
        ) : null}
      </div>
      {hasActions ? (
        <div className="mc-next-error-state-actions">
          {primaryAction !== undefined ? <div className="mc-next-error-state-primary">{primaryAction}</div> : null}
          {secondaryActions !== undefined ? (
            <div className="mc-next-error-state-secondary">{secondaryActions}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
