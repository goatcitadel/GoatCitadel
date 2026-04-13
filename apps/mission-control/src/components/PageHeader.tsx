import type { ReactNode } from "react";
import { PageChrome } from "./PageChrome";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  forceVisible?: boolean;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  hint,
  actions,
  className,
  forceVisible = false,
}: PageHeaderProps) {
  return (
    <PageChrome
      eyebrow={eyebrow}
      title={title}
      subtitle={subtitle}
      hint={hint}
      actions={actions}
      className={className}
      hideWhenEmbedded={!forceVisible}
      variant="hero"
    />
  );
}
