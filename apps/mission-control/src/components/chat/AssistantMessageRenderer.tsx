import { useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

function buildAssistantStatus(running: boolean): MessageStatus {
  if (running) {
    return { type: "running" };
  }

  return { type: "complete", reason: "stop" };
}

function createThreadMessage({
  role,
  content,
  running,
}: {
  role: "user" | "assistant";
  content: string;
  running: boolean;
}): ThreadMessage {
  if (role === "assistant") {
    return {
      id: `${role}-${content.length}-${running ? "running" : "complete"}`,
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
    id: `${role}-${content.length}`,
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
  const shouldUseFallback =
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    typeof document.getElementsByTagName !== "function" ||
    /jsdom/i.test(globalThis.navigator?.userAgent ?? "");

  if (shouldUseFallback) {
    return (
      <div className={cn("mc-assistant-renderer mc-assistant-renderer-fallback", className)}>
        <AssistantMessageContainer role={role} content={content}>
          <div
            className={cn(
              "mc-assistant-markdown",
              role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </AssistantMessageContainer>
      </div>
    );
  }

  return <AssistantMessageRuntimeRenderer role={role} content={content} running={running} className={className} />;
}

function AssistantMessageRuntimeRenderer({
  role,
  content,
  running,
  className,
}: {
  role: "user" | "assistant";
  content: string;
  running: boolean;
  className?: string;
}) {
  const messages = useMemo<readonly ThreadMessage[]>(
    () => [createThreadMessage({ role, content, running })],
    [content, role, running],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className={cn("mc-assistant-renderer", className)}>
        <ThreadPrimitive.Viewport
          autoScroll={false}
          scrollToBottomOnInitialize={false}
          className="mc-assistant-renderer-viewport"
        >
          <ThreadPrimitive.Messages>
            {() => (
              <MessagePrimitive.Root className="mc-assistant-renderer-message">
                <AssistantMessageContainer role={role} content={content}>
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
  children,
}: {
  role: "user" | "assistant";
  content: string;
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

  return (
    <div className="mc-assistant-renderer-shell">
      {role === "assistant" ? (
        <button
          type="button"
          className={cn("mc-assistant-copy-button", copied ? "copied" : "")}
          onClick={() => void handleCopy()}
          aria-label={copied ? "Response copied to clipboard" : "Copy response to clipboard"}
          title={copied ? "Copied" : "Copy"}
        >
          {copied ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2.2} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      ) : null}
      <div className="mc-assistant-renderer-body">{children}</div>
    </div>
  );
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
