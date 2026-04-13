import type { ReactNode } from "react";
import { PageChrome } from "./PageChrome";

interface SectionTitleProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}

export function SectionTitle({ title, subtitle, actions, eyebrow }: SectionTitleProps) {
  return (
    <PageChrome
      title={title}
      subtitle={subtitle}
      actions={actions}
      eyebrow={eyebrow}
      className="section-title"
      variant="section"
    />
  );
}
