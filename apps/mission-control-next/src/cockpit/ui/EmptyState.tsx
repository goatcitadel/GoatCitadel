import type { ReactNode } from "react";

/**
 * Not a live region: an empty state is page content, announced by the page's own heading structure. Use
 * headingLevel={1} when the empty state is the whole page (for example an access gate).
 */
export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  headingLevel?: 1 | 2 | 3;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Heading className="font-display text-lg text-fg">{title}</Heading>
      {description ? <p className="max-w-md text-base text-fg-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
