import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useEmbeddedPageChrome } from "./EmbeddedPageChrome";

interface PageChromeProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
  hint?: ReactNode;
  className?: string;
  variant?: "hero" | "section";
  density?: "standard" | "compact";
  hideWhenEmbedded?: boolean;
}

export function PageChrome({
  title,
  subtitle,
  actions,
  eyebrow,
  hint,
  className,
  variant = "hero",
  density = "standard",
  hideWhenEmbedded = false,
}: PageChromeProps) {
  const embedded = useEmbeddedPageChrome();
  if (embedded && hideWhenEmbedded) {
    return null;
  }

  const hasActions = Boolean(actions);
  const hasHint = Boolean(hint);
  const hasMeta = Boolean(subtitle || hint);

  return (
    <header
      className={cn(
        "page-chrome mc-page-chrome",
        `page-chrome-${variant}`,
        `page-chrome-density-${density}`,
        "page-header",
        hasActions && "page-header-has-actions",
        hasHint && "page-header-has-hint",
        className,
      )}
    >
      <div className="page-chrome-copy page-header-main">
        {eyebrow ? <p className="page-chrome-eyebrow page-header-eyebrow">{eyebrow}</p> : null}
        <div className="page-chrome-row page-header-title-row">
          <h2 className="page-chrome-title page-header-title">{title}</h2>
          {hasActions ? <div className="page-chrome-actions page-header-actions mobile-only">{actions}</div> : null}
        </div>
        {hasMeta ? (
          <div className="page-chrome-meta page-header-meta">
            {subtitle ? <div className="page-chrome-subtitle page-header-subtitle">{subtitle}</div> : null}
            {hasHint ? <div className="page-chrome-hint page-header-hint">{hint}</div> : null}
          </div>
        ) : null}
      </div>
      {hasActions ? <div className="page-chrome-actions page-header-actions desktop-only">{actions}</div> : null}
    </header>
  );
}
