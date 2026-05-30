import { memo, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { normalizeAssistantDisplayText } from "./assistant-display-text";

export type AssistantStreamPresentationMode = "smooth" | "instant";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

export function AssistantMessageRenderer({
  role,
  content,
  running = false,
  streamPresentationMode = "smooth",
  className,
}: {
  role: "user" | "assistant";
  content: string;
  running?: boolean;
  streamPresentationMode?: AssistantStreamPresentationMode;
  className?: string;
}) {
  const displayContent = useMemo(
    () => (role === "assistant" ? normalizeAssistantDisplayText(content) : content),
    [role, content],
  );

  return (
    <div
      className={cn(
        "mc-assistant-renderer mc-assistant-renderer-markdown",
        running ? "mc-assistant-renderer-running" : "",
        `mc-assistant-stream-${streamPresentationMode}`,
        className,
      )}
    >
      <AssistantMessageContainer role={role} content={displayContent} running={running}>
        {role === "assistant" && running ? (
          <StreamingMarkdown content={displayContent} streamPresentationMode={streamPresentationMode} />
        ) : (
          <MemoizedMarkdownBlock content={displayContent} role={role} components={assistantMarkdownComponents} />
        )}
      </AssistantMessageContainer>
    </div>
  );
}

const assistantMarkdownComponents: Components = {
  a({ children, href, node: _node, ...props }) {
    const safeHref = resolveSafeMarkdownHref(href);
    if (!safeHref) {
      return <span className="mc-assistant-link-disabled">{children}</span>;
    }
    const external = isExternalMarkdownHref(safeHref);
    return (
      <a href={safeHref} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined} {...props}>
        {children}
      </a>
    );
  },
  blockquote({ children, node: _node, ...props }) {
    return <blockquote {...props}>{children}</blockquote>;
  },
  code({ children, className, node: _node, ...props }) {
    const content = String(children ?? "");
    const language = /language-([a-z0-9_+-]+)/i.exec(className ?? "")?.[1];
    const isBlock = Boolean(language || content.includes("\n"));
    if (isBlock) {
      return (
        <AssistantCodeBlock
          language={language}
          codeClassName={className}
          codeProps={props as HTMLAttributes<HTMLElement>}
          rawText={content}
        >
          {children}
        </AssistantCodeBlock>
      );
    }
    return (
      <code className={cn("mc-assistant-inline-code", className)} {...props}>
        {children}
      </code>
    );
  },
  li({ children, node: _node, ...props }) {
    return <li {...props}>{children}</li>;
  },
  ol({ children, node: _node, ...props }) {
    return <ol {...props}>{children}</ol>;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children, node: _node, ...props }) {
    return (
      <div className="mc-assistant-table-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  },
  tbody({ children, node: _node, ...props }) {
    return <tbody {...props}>{children}</tbody>;
  },
  td({ children, node: _node, ...props }) {
    return <td {...props}>{children}</td>;
  },
  th({ children, node: _node, ...props }) {
    return <th {...props}>{children}</th>;
  },
  thead({ children, node: _node, ...props }) {
    return <thead {...props}>{children}</thead>;
  },
  tr({ children, node: _node, ...props }) {
    return <tr {...props}>{children}</tr>;
  },
  ul({ children, node: _node, ...props }) {
    return <ul {...props}>{children}</ul>;
  },
};

function AssistantCodeBlock({
  language,
  codeClassName,
  codeProps,
  rawText,
  children,
}: {
  language: string | undefined;
  codeClassName: string | undefined;
  codeProps: HTMLAttributes<HTMLElement>;
  rawText: string;
  children: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);
  const trimmed = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;

  useEffect(() => {
    return () => {
      if (resetRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(resetRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await copyTextToClipboard(trimmed);
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

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy code";

  return (
    <div className="mc-assistant-code-shell" data-language={language ?? undefined}>
      <div className="mc-assistant-code-header">
        <span className="mc-assistant-code-language">{language ?? "code"}</span>
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
      </div>
      <pre className="mc-assistant-code-block">
        <code className={codeClassName} {...codeProps}>
          {children}
        </code>
      </pre>
    </div>
  );
}

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock({
  content,
  role,
  components,
}: {
  content: string;
  role: "user" | "assistant";
  components: Components;
}) {
  return (
    <div
      className={cn(
        "mc-assistant-markdown",
        role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
      )}
    >
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

function resolveSafeMarkdownHref(href: string | undefined): string | undefined {
  const trimmed = href?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.startsWith("#") ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//")) ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function isExternalMarkdownHref(href: string): boolean {
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
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
  children: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);
  const isStreamingAssistant = role === "assistant" && Boolean(running);
  const copyDisabled = role !== "assistant" || isStreamingAssistant || !content.trim();

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

  const copyButtonLabel = isStreamingAssistant
    ? "Copy available when response completes"
    : copyState === "copied"
      ? "Response copied to clipboard"
      : copyState === "failed"
        ? "Copy unavailable from this browser"
        : "Copy response to clipboard";
  const copyButtonTitle = isStreamingAssistant
    ? "Copy available when complete"
    : copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy unavailable"
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

function StreamingMarkdown({
  content,
  streamPresentationMode,
}: {
  content: string;
  streamPresentationMode: AssistantStreamPresentationMode;
}) {
  const { stable, tail } = useMemo(() => splitStreamingMarkdown(content), [content]);
  return (
    <div className="mc-assistant-streaming-markdown">
      {stable ? (
        <MemoizedMarkdownBlock content={stable} role="assistant" components={assistantMarkdownComponents} />
      ) : null}
      {tail ? (
        <div
          className={cn(
            "mc-assistant-streaming-tail",
            streamPresentationMode === "smooth" ? "mc-assistant-streaming-tail-smooth" : "",
          )}
        >
          <MemoizedMarkdownBlock content={tail} role="assistant" components={assistantMarkdownComponents} />
        </div>
      ) : null}
      <span className="mc-assistant-streaming-cursor" aria-hidden="true" />
    </div>
  );
}

export function splitStreamingMarkdown(content: string): { stable: string; tail: string } {
  let paragraphIndex = content.lastIndexOf("\n\n");
  while (paragraphIndex > 0) {
    const splitEnd = paragraphIndex + 2;
    if (isMarkdownFenceBalanced(content.slice(0, splitEnd))) {
      return {
        stable: content.slice(0, splitEnd),
        tail: content.slice(splitEnd),
      };
    }
    paragraphIndex = content.lastIndexOf("\n\n", paragraphIndex - 1);
  }
  return { stable: "", tail: content };
}

function isMarkdownFenceBalanced(markdown: string): boolean {
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) {
      continue;
    }
    const marker = match[1]!;
    const markerChar = marker[0] as "`" | "~";
    if (!inFence) {
      inFence = true;
      fenceChar = markerChar;
      fenceLength = marker.length;
      continue;
    }
    const markerTail = line.slice(line.indexOf(marker) + marker.length);
    if (markerChar === fenceChar && marker.length >= fenceLength && markerTail.trim().length === 0) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  }
  return !inFence;
}

export async function copyTextToClipboard(content: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable in this environment. Copy requires navigator.clipboard.writeText().");
  }
  await navigator.clipboard.writeText(content);
}
