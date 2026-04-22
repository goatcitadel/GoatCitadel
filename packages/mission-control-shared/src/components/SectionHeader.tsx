import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface SectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, subtitle, actions, className }: SectionHeaderProps) {
  return (
    <header className={cn("section-header mc-section-header", className)}>
      <div className="section-header-copy">
        <h3 className="section-header-title">{title}</h3>
        {subtitle ? <div className="section-header-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="section-header-actions">{actions}</div> : null}
    </header>
  );
}
