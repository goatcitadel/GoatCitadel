import { useId, type ReactNode } from "react";

/**
 * A flat page region (DESIGN.md › Page anatomy): a heading, an optional one-line description and actions, then the
 * content, separated from the region above by a hairline. Use it instead of a bordered card inside the page card.
 */
export function Section({
  title,
  description,
  actions,
  children,
  headingLevel = 2,
  className,
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  /** A fragment target, for links that land on this region. */
  id?: string;
}) {
  const headingId = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`border-t border-line-subtle pt-4 first:border-t-0 first:pt-0 ${className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Heading id={headingId} className="text-base font-semibold text-fg">
            {title}
          </Heading>
          {description ? <p className="mt-0.5 text-sm text-fg-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
