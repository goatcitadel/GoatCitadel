import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type MessageStatus,
  type ThreadMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
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
        <div className="mc-assistant-renderer-message">
          <div
            className={cn(
              "mc-assistant-markdown",
              role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
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
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
