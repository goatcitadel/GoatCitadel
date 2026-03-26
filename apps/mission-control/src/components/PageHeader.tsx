import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  hint,
  actions,
  className,
}: PageHeaderProps) {
  const hasActions = Boolean(actions);
  const hasHint = Boolean(hint);
  const hasMeta = Boolean(subtitle || hint);
  return (
    <header className={`page-header${hasActions ? " page-header-has-actions" : ""}${hasHint ? " page-header-has-hint" : ""}${className ? ` ${className}` : ""}`}>
      <div className="page-header-main">
        {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
        <div className="page-header-title-row">
          <h2 className="page-header-title">{title}</h2>
          {hasActions ? <div className="page-header-actions mobile-only">{actions}</div> : null}
        </div>
        {hasMeta ? (
          <div className="page-header-meta">
            {subtitle ? <div className="page-header-subtitle">{subtitle}</div> : null}
            {hasHint ? <div className="page-header-hint">{hint}</div> : null}
          </div>
        ) : null}
      </div>
      {hasActions ? <div className="page-header-actions desktop-only">{actions}</div> : null}
    </header>
  );
}
