import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type MessageStatus,
  type ThreadMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { normalizeAssistantDisplayText } from "./assistant-display-text";

function buildAssistantStatus(running: boolean): MessageStatus {
  if (running) {
    return { type: "running" };
  }

  return { type: "complete", reason: "stop" };
}

function createThreadMessage({
  role,
  id,
  content,
  running,
}: {
  role: "user" | "assistant";
  id: string;
  content: string;
  running: boolean;
}): ThreadMessage {
  if (role === "assistant") {
    return {
      id,
      role,
      createdAt: new Date(0),
      content: [{ type: "text", text: content || " " }],
      status: buildAssistantStatus(running),
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
  }

  return {
    id,
    role,
    createdAt: new Date(0),
    content: [{ type: "text", text: content }],
    attachments: [],
    metadata: {
      custom: {},
    },
  };
}

export function AssistantMessageRenderer({
  role,
  content,
  running = false,
  className,
}: {
  role: "user" | "assistant";
  content: string;
  running?: boolean;
  className?: string;
}) {
  const stableMessageId = useId();
  const displayContent = role === "assistant" ? normalizeAssistantDisplayText(content) : content;
  const assistantUiRuntimeEnabled =
    (globalThis as { __GOATCITADEL_ENABLE_ASSISTANT_UI_RENDERER?: boolean })
      .__GOATCITADEL_ENABLE_ASSISTANT_UI_RENDERER === true;
  const shouldUseFallback =
    !assistantUiRuntimeEnabled ||
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    typeof document.getElementsByTagName !== "function" ||
    /jsdom/i.test(globalThis.navigator?.userAgent ?? "");

  if (shouldUseFallback) {
    return (
      <div
        className={cn(
          "mc-assistant-renderer mc-assistant-renderer-fallback",
          running ? "mc-assistant-renderer-running" : "",
          className,
        )}
      >
        <AssistantMessageContainer role={role} content={displayContent} running={running}>
          <div
            className={cn(
              "mc-assistant-markdown",
              role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
            )}
          >
            {role === "assistant" && running ? (
              <StreamingMarkdown content={displayContent} />
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            )}
          </div>
        </AssistantMessageContainer>
      </div>
    );
  }

  return (
    <AssistantMessageRuntimeRenderer
      role={role}
      messageId={stableMessageId}
      content={displayContent}
      running={running}
      className={className}
    />
  );
}

function AssistantMessageRuntimeRenderer({
  role,
  messageId,
  content,
  running,
  className,
}: {
  role: "user" | "assistant";
  messageId: string;
  content: string;
  running: boolean;
  className?: string;
}) {
  const messages = useMemo<readonly ThreadMessage[]>(
    () => [createThreadMessage({ role, id: messageId, content, running })],
    [content, messageId, role, running],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root
        className={cn("mc-assistant-renderer", running ? "mc-assistant-renderer-running" : "", className)}
      >
        <ThreadPrimitive.Viewport
          autoScroll={false}
          scrollToBottomOnInitialize={false}
          className="mc-assistant-renderer-viewport"
        >
          <ThreadPrimitive.Messages>
            {() => (
              <MessagePrimitive.Root className="mc-assistant-renderer-message">
                <AssistantMessageContainer role={role} content={content} running={running}>
                  <MessagePrimitive.Parts
                    components={{
                      Text: () => (
                        <MarkdownTextPrimitive
                          className={cn(
                            "mc-assistant-markdown",
                            role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
                          )}
                        />
                      ),
                    }}
                  />
                </AssistantMessageContainer>
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function AssistantMessageContainer({
  role,
  content,
  running,
  children,
}: {
  role: "user" | "assistant";
  content: string;
  running?: boolean;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
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
    await copyTextToClipboard(content);
    setCopied(true);
    if (typeof window !== "undefined") {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1800);
    }
  }

  const isStreamingAssistant = role === "assistant" && Boolean(running);
  // H-2 (docs/review/mission-control-next-ship-punchlist.md): Wire streaming
  // assistant text into a live region so SR follows the response. `aria-live`
  // is conditional — applied only while streaming so unrelated DOM updates
  // (timestamps, copy-button toggle) don't get re-announced after completion.
  // `aria-atomic="false"` makes assistive tech read only the new chunks, not
  // the whole bubble each tick.
  return (
    <div
      className="mc-assistant-renderer-shell"
      aria-busy={isStreamingAssistant ? true : undefined}
      aria-live={isStreamingAssistant ? "polite" : undefined}
      aria-atomic={isStreamingAssistant ? false : undefined}
    >
      <div className="mc-assistant-renderer-body">{children}</div>
      {role === "assistant" ? (
        <button
          type="button"
          className={cn("mc-assistant-copy-button", copied ? "copied" : "")}
          onClick={() => void handleCopy()}
          aria-label={copied ? "Response copied to clipboard" : "Copy response to clipboard"}
          title={copied ? "Copied" : "Copy"}
        >
          {copied ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2.2} />}
        </button>
      ) : null}
    </div>
  );
}

function StreamingMarkdown({ content }: { content: string }) {
  const { stable, tail } = useMemo(() => splitStreamingMarkdown(content), [content]);
  return (
    <div className="mc-assistant-streaming-markdown">
      {stable ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{stable}</ReactMarkdown> : null}
      {tail ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{tail}</ReactMarkdown> : null}
      <span className="mc-assistant-streaming-cursor" aria-hidden="true" />
    </div>
  );
}

function splitStreamingMarkdown(content: string): { stable: string; tail: string } {
  const fencedBlockIndex = content.lastIndexOf("\n```");
  const paragraphIndex = content.lastIndexOf("\n\n");
  const splitIndex = Math.max(fencedBlockIndex, paragraphIndex);
  if (splitIndex <= 0) {
    return { stable: "", tail: content };
  }
  return {
    stable: content.slice(0, splitIndex + 1),
    tail: content.slice(splitIndex + 1),
  };
}

async function copyTextToClipboard(content: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable.");
  }
  const textArea = document.createElement("textarea");
  textArea.value = content;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  textArea.style.pointerEvents = "none";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}
