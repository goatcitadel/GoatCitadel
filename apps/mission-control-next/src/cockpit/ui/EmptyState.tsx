import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <section role="status" className="flex flex-col items-center gap-2 px-6 py-12 text-center">
    <h2 className="font-display text-lg text-fg">{title}</h2>
    {description ? <p className="max-w-md text-base text-fg-secondary">{description}</p> : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </section>;
}
