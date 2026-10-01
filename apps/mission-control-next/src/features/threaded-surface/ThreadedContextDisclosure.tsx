import { useId, useState, type ReactNode } from "react";

export function ContextDisclosure({
  children,
  defaultOpen = false,
  summary,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  summary: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <details
      className="mc-next-context-detail-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-controls={contentId} aria-expanded={open}>
        {summary}
      </summary>
      <div id={contentId}>{children}</div>
    </details>
  );
}
