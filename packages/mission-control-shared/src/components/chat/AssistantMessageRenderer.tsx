import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Copy, FileDown } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import type { Processor } from "unified";
import { createIncrementalSplitState, splitIncremental, type IncrementalSplitState } from "./streaming-markdown";
export {
  createIncrementalSplitState,
  splitIncremental,
  splitStreamingMarkdown,
  buildDefinitionSuffix,
} from "./streaming-markdown";
export type { IncrementalSplitState } from "./streaming-markdown";
import { downloadFile } from "../../api/client";
import { cn } from "../../lib/utils";
import {
  createIncrementalDisplayTextState,
  normalizeAssistantDisplayText,
  normalizeAssistantDisplayTextIncremental,
  type IncrementalDisplayTextState,
} from "./assistant-display-text";
import { AssistantStreamingTailContext, HighlightedCode } from "./HighlightedCode";
import { LazyOpenUiStructuredBlock } from "./LazyOpenUiStructuredBlock";
import { isGoatOpenUiRendererEnabled } from "./openui-flag";

export type AssistantStreamPresentationMode = "smooth" | "instant";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const WORKSPACE_FILE_DOWNLOAD_PATH = "/api/v1/files/download";
const WORKSPACE_FILE_OBJECT_URL_REVOKE_DELAY_MS = 5 * 60 * 1000;

export function AssistantMessageRenderer({
  role,
  content,
  running = false,
  streamPresentationMode = "smooth",
  streamTurnId,
  className,
}: {
  role: "user" | "assistant";
  content: string;
  running?: boolean;
  streamPresentationMode?: AssistantStreamPresentationMode;
  // Identifies the streaming turn so the incremental markdown split can reset its carried
  // parser state when a new message starts. Optional: omitted for settled / user content.
  streamTurnId?: string;
  className?: string;
}) {
  // While streaming, `content` grows on every preview flush, so a plain
  // useMemo on it re-runs the full normalization pipeline over the whole
  // accumulated message per token (O(n^2) cumulative). Carry incremental
  // state across tokens of the same streaming turn instead — same pattern
  // as StreamingMarkdown's splitIncremental below — and reset it when the
  // turn identity changes. Settled content keeps the one-shot path: it
  // normalizes once and the memo holds.
  const normalizeStateRef = useRef<IncrementalDisplayTextState | undefined>(undefined);
  const normalizeTurnRef = useRef<string | undefined>(undefined);
  const displayContent = useMemo(() => {
    if (role !== "assistant") {
      return content;
    }
    if (!running) {
      return normalizeAssistantDisplayText(content);
    }
    if (normalizeStateRef.current === undefined || normalizeTurnRef.current !== streamTurnId) {
      normalizeStateRef.current = createIncrementalDisplayTextState();
      normalizeTurnRef.current = streamTurnId;
    }
    return normalizeAssistantDisplayTextIncremental(normalizeStateRef.current, content);
  }, [role, content, running, streamTurnId]);

  return (
    <div
      className={cn(
        "mc-assistant-renderer mc-assistant-renderer-markdown",
        running ? "mc-assistant-renderer-running" : "",
        `mc-assistant-stream-${streamPresentationMode}`,
        className,
      )}
    >
      <AssistantMessageContainer role={role} content={content} running={running}>
        {role === "assistant" && running ? (
          <StreamingMarkdown
            content={displayContent}
            streamPresentationMode={streamPresentationMode}
            streamTurnId={streamTurnId}
          />
        ) : (
          <MemoizedMarkdownBlock
            content={displayContent}
            role={role}
            components={role === "assistant" ? assistantMarkdownComponents : userMarkdownComponents}
          />
        )}
      </AssistantMessageContainer>
    </div>
  );
}

function createMarkdownComponents({ allowGeneratedUi }: { allowGeneratedUi: boolean }): Components {
  return {
    a({ children, href, node: _node, ...props }) {
      const safeHref = resolveSafeMarkdownHref(href);
      if (!safeHref) {
        return <span className="mc-assistant-link-disabled">{children}</span>;
      }
      const workspaceFile = allowGeneratedUi ? parseWorkspaceFileDownloadHref(safeHref) : undefined;
      if (workspaceFile) {
        return (
          <WorkspaceFileDownloadLink
            href={safeHref}
            relativePath={workspaceFile.relativePath}
            fileName={workspaceFile.fileName}
            {...props}
          >
            {children}
          </WorkspaceFileDownloadLink>
        );
      }
      const external = isExternalMarkdownHref(safeHref);
      return (
        <a
          href={safeHref}
          rel={external ? "noreferrer" : undefined}
          target={external ? "_blank" : undefined}
          {...props}
        >
          {children}
        </a>
      );
    },
    blockquote({ children, node: _node, ...props }) {
      return <blockquote {...props}>{children}</blockquote>;
    },
    code({ children, className, node, ...props }) {
      const content = String(children ?? "");
      const language = /language-([a-z0-9_+-]+)/i.exec(className ?? "")?.[1];
      const isBlock = isMarkdownCodeBlock(content, className, node);
      if (isBlock) {
        return (
          <AssistantCodeBlock
            language={language}
            codeClassName={className}
            codeProps={props as HTMLAttributes<HTMLElement>}
            rawText={content}
            allowGeneratedUi={allowGeneratedUi}
          />
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
}

function WorkspaceFileDownloadLink({
  children,
  href,
  relativePath,
  fileName,
  className,
  ...props
}: {
  children: ReactNode;
  href: string;
  relativePath: string;
  fileName: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href">) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <a
        href={href}
        className={cn("mc-assistant-file-link", className)}
        aria-busy={downloading || undefined}
        {...props}
        onClick={(event) => {
          event.preventDefault();
          if (downloading) {
            return;
          }
          setDownloading(true);
          setError(null);
          void downloadWorkspaceFileToDevice(relativePath, fileName)
            .catch(() => {
              setError("Download failed. Try again or open the file from Library.");
            })
            .finally(() => {
              setDownloading(false);
            });
        }}
      >
        <FileDown className="mc-assistant-file-link-icon" size={14} strokeWidth={2.2} aria-hidden="true" />
        <span>{children}</span>
      </a>
      {error ? (
        <span className="mc-assistant-link-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function parseWorkspaceFileDownloadHref(href: string): { relativePath: string; fileName: string } | undefined {
  const prefix = `${WORKSPACE_FILE_DOWNLOAD_PATH}?`;
  if (!href.startsWith(prefix) || href.includes("#")) {
    return undefined;
  }
  const params = new URLSearchParams(href.slice(prefix.length));
  const relativePaths = params.getAll("relativePath");
  if ([...params.keys()].length !== 1 || relativePaths.length !== 1) {
    return undefined;
  }
  const relativePath = relativePaths[0]?.trim();
  if (!relativePath || !isSafeWorkspaceRelativePath(relativePath)) {
    return undefined;
  }
  const fileName = relativePath.split("/").at(-1);
  return fileName ? { relativePath, fileName } : undefined;
}

export async function downloadWorkspaceFileToDevice(relativePath: string, fallbackFileName?: string): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new Error("Workspace file downloads are unavailable in this environment.");
  }
  const file = await downloadFile(relativePath);
  const content =
    file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0))
      : file.encoding === "utf8"
        ? file.content
        : undefined;
  if (content === undefined) {
    throw new Error(`Unsupported workspace file encoding: ${file.encoding}`);
  }
  const objectUrl = URL.createObjectURL(new Blob([content], { type: file.contentType || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.relativePath.split(/[\\/]/u).at(-1) || fallbackFileName || "download";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), WORKSPACE_FILE_OBJECT_URL_REVOKE_DELAY_MS);
}

function isSafeWorkspaceRelativePath(relativePath: string): boolean {
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[a-z]:/iu.test(relativePath) ||
    // eslint-disable-next-line no-control-regex -- reject control characters in a download target
    /[\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isMarkdownCodeBlock(content: string, className: string | undefined, node: unknown): boolean {
  if (className && /(?:^|\s)language-/i.test(className)) {
    return true;
  }
  if (content.includes("\n")) {
    return true;
  }
  const position = (node as { position?: { start?: { line?: number }; end?: { line?: number } } } | undefined)
    ?.position;
  const startLine = position?.start?.line;
  const endLine = position?.end?.line;
  return typeof startLine === "number" && typeof endLine === "number" && endLine > startLine;
}

const assistantMarkdownComponents = createMarkdownComponents({ allowGeneratedUi: true });
const userMarkdownComponents = createMarkdownComponents({ allowGeneratedUi: false });

function AssistantCodeBlock({
  language,
  codeClassName,
  codeProps,
  rawText,
  allowGeneratedUi,
}: {
  language: string | undefined;
  codeClassName: string | undefined;
  codeProps: HTMLAttributes<HTMLElement>;
  rawText: string;
  allowGeneratedUi: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetRef = useRef<ReturnType<Window["setTimeout"]> | null>(null);
  const trimmed = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;
  const isOpenUiBlock = language?.toLowerCase() === "openui";

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

  const codeBlock = (
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
        <HighlightedCode code={trimmed} language={language} codeClassName={codeClassName} codeProps={codeProps} />
      </pre>
    </div>
  );
  // A generated OpenUI block renders only when the flag is on and its source parses; the renderer loads on demand.
  if (allowGeneratedUi && isOpenUiBlock && isGoatOpenUiRendererEnabled()) {
    return <LazyOpenUiStructuredBlock source={trimmed} fallback={codeBlock} />;
  }
  return codeBlock;
}

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock({
  content,
  role,
  components,
  tree,
}: {
  content: string;
  role: "user" | "assistant";
  components: Components;
  tree?: Root;
}) {
  const plugins = useMemo(
    () =>
      tree
        ? [
            remarkGfm,
            function useParsedTree(this: Processor) {
              // Reuse the AST already parsed for semantic boundaries. ReactMarkdown still
              // owns GFM-to-HTML conversion, safe links and all existing code renderers.
              this.parser = () => tree;
            },
          ]
        : MARKDOWN_REMARK_PLUGINS,
    [tree],
  );
  return (
    <div
      className={cn(
        "mc-assistant-markdown",
        role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant",
      )}
    >
      <ReactMarkdown remarkPlugins={plugins} components={components}>
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

function StreamingMarkdown({
  content,
  streamPresentationMode,
  streamTurnId,
}: {
  content: string;
  streamPresentationMode: AssistantStreamPresentationMode;
  // Identifies the streaming turn so the incremental parser state is reset when a new
  // message starts (fence-state must never leak across messages).
  streamTurnId?: string;
}) {
  const splitStateRef = useRef<IncrementalSplitState | undefined>(undefined);
  const splitIdentityRef = useRef<string | undefined>(undefined);
  const identity = JSON.stringify([streamTurnId, streamPresentationMode, isGoatOpenUiRendererEnabled()]);
  const { blocks, tail, tailTree } = useMemo(() => {
    if (!splitStateRef.current || splitIdentityRef.current !== identity) {
      splitStateRef.current = createIncrementalSplitState();
      splitIdentityRef.current = identity;
    }
    const split = splitIncremental(splitStateRef.current, content);
    return { blocks: splitStateRef.current.blocks, tail: split.tail, tailTree: splitStateRef.current.tailTree };
  }, [content, identity]);
  return (
    <div className="mc-assistant-streaming-markdown">
      {blocks.map((block) => (
        <MemoizedMarkdownBlock
          key={identity + ":" + block.start + ":" + block.end}
          content={block.source}
          tree={block.tree}
          role="assistant"
          components={assistantMarkdownComponents}
        />
      ))}
      {tail ? (
        <div
          className={cn(
            "mc-assistant-streaming-tail",
            streamPresentationMode === "smooth" ? "mc-assistant-streaming-tail-smooth" : "",
          )}
        >
          <AssistantStreamingTailContext.Provider value={true}>
            <MemoizedMarkdownBlock
              content={tail}
              tree={tailTree}
              role="assistant"
              components={assistantMarkdownComponents}
            />
          </AssistantStreamingTailContext.Provider>
        </div>
      ) : null}
      <span className="mc-assistant-streaming-cursor" aria-hidden="true" />
    </div>
  );
}

export async function copyTextToClipboard(content: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable in this environment. Copy requires navigator.clipboard.writeText().");
  }
  await navigator.clipboard.writeText(content);
}
