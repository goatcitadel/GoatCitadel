import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Not a live region: an empty state is page content, announced by the page's own heading structure. Use
 * headingLevel={1} when the empty state is the whole page (for example an access gate). `tone="error"` marks a failed
 * load with an icon above the heading; it stays page content, never a live region.
 */
export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
  tone = "empty",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  headingLevel?: 1 | 2 | 3;
  tone?: "empty" | "error";
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {tone === "error" ? <CircleAlert aria-hidden="true" className="size-5 text-status-failed" /> : null}
      <Heading className="font-display text-lg text-fg">{title}</Heading>
      {description ? <p className="max-w-md text-base text-fg-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
