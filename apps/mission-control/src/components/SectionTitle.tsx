import type { ReactNode } from "react";

interface SectionTitleProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}

export function SectionTitle({ title, subtitle, actions, eyebrow }: SectionTitleProps) {
  return (
    <header className="section-title">
      <div className="section-title-copy">
        {eyebrow ? <p className="section-title-eyebrow">{eyebrow}</p> : null}
        <div className="section-title-row">
          <h2 className="section-title-heading">{title}</h2>
          {actions ? <div className="section-title-actions mobile-only">{actions}</div> : null}
        </div>
        {subtitle ? <div className="section-title-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="section-title-actions desktop-only">{actions}</div> : null}
    </header>
  );
}
