import type { ReactNode } from "react";
import { SectionHeader } from "./SectionHeader";

type PanelTone = "default" | "soft" | "accent" | "warning" | "critical";
type PanelPadding = "default" | "compact" | "spacious";
type PanelRank = "primary" | "muted" | "elevated" | "inset";

interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tone?: PanelTone;
  rank?: PanelRank;
  padding?: PanelPadding;
  className?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultExpanded?: boolean;
}

export function Panel({
  title,
  subtitle,
  actions,
  tone = "default",
  rank = "primary",
  padding = "default",
  className,
  children,
  collapsible = false,
  defaultExpanded = true,
}: PanelProps) {
  const hasHeader = Boolean(title || subtitle || actions);
  if (collapsible) {
    return (
      <details
        className={`panel panel-${tone} panel-${rank} panel-pad-${padding}${hasHeader ? " panel-has-header" : ""} panel-collapsible${className ? ` ${className}` : ""}`}
        data-tone={tone}
        data-rank={rank}
        data-padding={padding}
        open={defaultExpanded}
      >
        <summary className="panel-summary">
          {hasHeader ? (
            <SectionHeader title={title ?? ""} subtitle={subtitle} actions={actions} />
          ) : (
            <span className="panel-summary-label">Details</span>
          )}
        </summary>
        <div className="panel-body">{children}</div>
      </details>
    );
  }
  return (
    <article
      className={`panel panel-${tone} panel-${rank} panel-pad-${padding}${hasHeader ? " panel-has-header" : ""}${className ? ` ${className}` : ""}`}
      data-tone={tone}
      data-rank={rank}
      data-padding={padding}
    >
      {hasHeader ? <SectionHeader title={title ?? ""} subtitle={subtitle} actions={actions} /> : null}
      <div className="panel-body">{children}</div>
    </article>
  );
}
