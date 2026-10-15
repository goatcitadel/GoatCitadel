import { useId, useState, type ReactNode } from "react";

export function ContextDisclosure({
  children,
  defaultOpen = false,
  className = "mc-next-context-detail-disclosure",
  summary,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summary: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-controls={contentId} aria-expanded={open}>
        {summary}
      </summary>
      <div id={contentId}>{children}</div>
    </details>
  );
}
