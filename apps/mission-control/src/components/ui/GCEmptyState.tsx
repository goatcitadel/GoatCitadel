import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";

interface GCEmptyStateProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function GCEmptyState({ title, subtitle, action }: GCEmptyStateProps) {
  return (
    <Card className="gc-empty-state mc-gc-empty-state border-dashed bg-card/70">
      <CardHeader className="items-start gap-2">
        <CardTitle className="gc-empty-title text-sm">{title}</CardTitle>
        {subtitle ? <CardDescription className="gc-empty-subtitle">{subtitle}</CardDescription> : null}
      </CardHeader>
      {action ? <CardContent className="gc-empty-action pt-0">{action}</CardContent> : null}
    </Card>
  );
}
