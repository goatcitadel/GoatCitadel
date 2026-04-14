import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";

interface GCEmptyStateProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  meta?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function GCEmptyState({
  title,
  subtitle,
  action,
  secondaryAction,
  meta,
  compact = true,
  className,
}: GCEmptyStateProps) {
  return (
    <Card
      className={cn(
        "gc-empty-state mc-gc-empty-state border-dashed bg-card/70",
        compact && "gc-empty-state-compact",
        className,
      )}
    >
      <CardHeader className="items-start gap-2">
        <CardTitle className="gc-empty-title text-sm">{title}</CardTitle>
        {subtitle ? <CardDescription className="gc-empty-subtitle">{subtitle}</CardDescription> : null}
      </CardHeader>
      {action || secondaryAction || meta ? (
        <CardContent className="gc-empty-action pt-0">
          {action ? <div className="gc-empty-primary-action">{action}</div> : null}
          {secondaryAction ? <div className="gc-empty-secondary-action">{secondaryAction}</div> : null}
          {meta ? <div className="gc-empty-meta">{meta}</div> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
