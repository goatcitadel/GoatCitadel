import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "../../lib/utils";
import { copyTextToClipboard } from "./AssistantMessageRenderer";
import { parseUnifiedDiffLines } from "./chat-tool-diff";

/**
 * Claude Code-style +/- rendering for a tool result that carries a unified diff
 * (see `extractUnifiedDiffFromToolRun`). Renders the classified, capped line list
 * from `parseUnifiedDiffLines` plus a copy button that always copies the FULL
 * `diff` prop — never the truncated view — so "Copy" never silently drops lines
 * the viewport didn't render.
 */
export function ChatToolDiffBlock({ diff, maxLines }: { diff: string; maxLines?: number }) {
  const { lines, truncatedCount } = parseUnifiedDiffLines(diff, maxLines);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);

  useEffect(() => {
    return () => {
      if (resetRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(resetRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await copyTextToClipboard(diff);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (typeof window !== "undefined") {
      if (resetRef.current !== null) {
        window.clearTimeout(resetRef.current);
      }
      resetRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetRef.current = null;
      }, 1800);
    }
  }

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy diff";

  return (
    <div className="mc-next-tool-diff-shell">
      <button
        type="button"
        className={cn(
          "mc-assistant-code-copy",
          copyState === "copied" ? "copied" : "",
          copyState === "failed" ? "failed" : "",
        )}
        onClick={() => void handleCopy()}
        aria-label={copyLabel}
        title={copyLabel}
      >
        {copyState === "copied" ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={2.4} />}
      </button>
      <pre className="mc-next-tool-diff" tabIndex={0}>
        {lines.map((line, index) => (
          <span key={index} className={`line ${line.kind}`}>
            {line.text + "\n"}
          </span>
        ))}
      </pre>
      {truncatedCount > 0 ? <p className="mc-next-tool-diff-more">+{truncatedCount} more lines</p> : null}
    </div>
  );
}
