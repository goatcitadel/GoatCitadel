import { useId, useState, type ReactNode } from "react";

/** A message longer than this is clamped in the transcript until the reader asks for all of it. */
export const CLAMP_USER_MESSAGE_CHARS = 3_000;

/**
 * Keeps a very long message from filling the transcript. The full text stays in the page (only clipped), so
 * find-in-page and assistive technology still reach it.
 */
export function ChatClampedUserMessage({ text, children }: { text: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  if (text.length < CLAMP_USER_MESSAGE_CHARS) return <>{children}</>;
  return (
    <>
      <div id={regionId} className={expanded ? undefined : "max-h-64 overflow-hidden"}>
        {children}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((open) => !open)}
        className="mt-1 inline-flex min-h-8 items-center text-sm font-medium text-accent hover:underline max-sm:min-h-11"
      >
        {expanded ? "Show less" : "Show full message"}
      </button>
    </>
  );
}
