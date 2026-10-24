import { useState } from "react";

/** Longer summaries (fetched page text, command output) start collapsed to a short preview. */
export const TOOL_SUMMARY_COLLAPSE_CHARS = 280;

/** One tool row's summary line. A long one shows a two-line preview until the operator expands it. */
export function ChatToolRunSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= TOOL_SUMMARY_COLLAPSE_CHARS) return <p className="w-full text-fg-secondary">{text}</p>;
  return (
    <div className="w-full">
      <p
        className={`text-fg-secondary wrap-anywhere ${expanded ? "" : "line-clamp-2 cursor-pointer"}`}
        onClick={expanded ? undefined : () => setExpanded(true)}
      >
        {text}
      </p>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="mt-1 text-accent hover:underline"
      >
        {expanded ? "Show less" : "Show full output"}
      </button>
    </div>
  );
}
