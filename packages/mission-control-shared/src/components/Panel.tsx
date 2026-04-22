import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { SectionHeader } from "./SectionHeader";
import { Card, CardContent } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

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
  const [open, setOpen] = useState(defaultExpanded);

  if (collapsible) {
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card
          className={cn(
            "panel mc-panel",
            `panel-${tone}`,
            `panel-${rank}`,
            `panel-pad-${padding}`,
            hasHeader && "panel-has-header",
            "panel-collapsible",
            className,
          )}
          data-tone={tone}
          data-rank={rank}
          data-padding={padding}
        >
          <CollapsibleTrigger asChild>
            <button type="button" className="panel-summary mc-panel-summary">
              {hasHeader ? (
                <SectionHeader title={title ?? ""} subtitle={subtitle} actions={actions} />
              ) : (
                <span className="panel-summary-label">Details</span>
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent data-open={open}>
            <CardContent className="panel-body mc-panel-body">{children}</CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  }
  return (
    <Card
      className={cn(
        "panel mc-panel",
        `panel-${tone}`,
        `panel-${rank}`,
        `panel-pad-${padding}`,
        hasHeader && "panel-has-header",
        className,
      )}
      data-tone={tone}
      data-rank={rank}
      data-padding={padding}
    >
      {hasHeader ? <SectionHeader title={title ?? ""} subtitle={subtitle} actions={actions} /> : null}
      <CardContent className="panel-body mc-panel-body">{children}</CardContent>
    </Card>
  );
}
