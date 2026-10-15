import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils";

export function AssistantMessageContainer({
  role,
  content,
  running,
  children,
}: {
  role: "user" | "assistant";
  content: string;
  running?: boolean;
  children: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);
  const isStreamingAssistant = role === "assistant" && Boolean(running);
  // A long answer is worth copying before it finishes. The button stays live while
  // streaming, but says "so far" everywhere it is announced so nobody mistakes a
  // partial copy for the finished response.
  const copyDisabled = role !== "assistant" || !content.trim();

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (copyDisabled) {
      return;
    }
    try {
      await copyTextToClipboard(content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (typeof window !== "undefined") {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetTimerRef.current = null;
      }, 1800);
    }
  }

  const copyButtonLabel =
    copyState === "copied"
      ? isStreamingAssistant
        ? "Partial response copied to clipboard"
        : "Response copied to clipboard"
      : copyState === "failed"
        ? "Copy unavailable from this browser"
        : isStreamingAssistant
          ? "Copy the response so far; it is still being written"
          : "Copy response to clipboard";
  const copyButtonTitle =
    copyState === "copied"
      ? isStreamingAssistant
        ? "Copied so far"
        : "Copied"
      : copyState === "failed"
        ? "Copy unavailable"
        : isStreamingAssistant
          ? "Copy so far"
          : "Copy";
  return (
    <div className="mc-assistant-renderer-shell" aria-busy={isStreamingAssistant ? true : undefined}>
      <div className="mc-assistant-renderer-body">{children}</div>
      {role === "assistant" ? (
        <button
          type="button"
          className={cn(
            "mc-assistant-copy-button",
            copyState === "copied" ? "copied" : "",
            copyState === "failed" ? "failed" : "",
          )}
          onClick={() => void handleCopy()}
          disabled={copyDisabled}
          aria-label={copyButtonLabel}
          title={copyButtonTitle}
        >
          {copyState === "copied" ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2.2} />}
        </button>
      ) : null}
    </div>
  );
}


export async function copyTextToClipboard(content: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable in this environment. Copy requires navigator.clipboard.writeText().");
  }
  await navigator.clipboard.writeText(content);
}
