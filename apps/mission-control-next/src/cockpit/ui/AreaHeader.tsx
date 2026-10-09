import type { ReactNode } from "react";

export function AreaHeader({ title, description, children, actions }: { title: string; description?: string; children?: ReactNode; actions?: ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-3">
    <div><h1 className="font-display text-xl font-semibold text-fg">{title}</h1>
      {description ? <p className="text-sm text-fg-secondary">{description}</p> : null}{children}
    </div>{actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
  </header>;
}
