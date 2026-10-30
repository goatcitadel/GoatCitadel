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
import remarkMath from "remark-math";
import type { Root } from "mdast";
import type { Pluggable, Processor } from "unified";
import {
  CHAT_MATH_OPTIONS,
  createIncrementalSplitState,
  splitIncremental,
  type IncrementalSplitState,
} from "./streaming-markdown";
export {
  createIncrementalSplitState,
  splitIncremental,
  splitStreamingMarkdown,
  buildDefinitionSuffix,
} from "./streaming-markdown";
export type { IncrementalSplitState } from "./streaming-markdown";
import { downloadFile } from "../../api/client";
import { cn } from "../../lib/utils";
import { AssistantMessageContainer, copyTextToClipboard } from "./AssistantMessageShell";
export { copyTextToClipboard } from "./AssistantMessageShell";
import {
  createIncrementalDisplayTextState,
  normalizeAssistantDisplayText,
  normalizeAssistantDisplayTextIncremental,
  type IncrementalDisplayTextState,
} from "./assistant-display-text";
import { ChatMathFormula } from "./ChatMathFormula";
import { AssistantStreamingTailContext, HighlightedCode } from "./HighlightedCode";
import { LazyOpenUiStructuredBlock } from "./LazyOpenUiStructuredBlock";
import { isGoatOpenUiRendererEnabled } from "./openui-flag";
import { isProseFence } from "./prose-fence";
import { rehypeFadeNewWords } from "./rehype-fade-new-words";
import { useSteadyStreamText } from "./use-steady-stream-text";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export type AssistantStreamPresentationMode = "smooth" | "instant";

const MATH_PLUGIN: Pluggable = [remarkMath, CHAT_MATH_OPTIONS];
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, MATH_PLUGIN];
const FADE_NEW_WORDS_PLUGINS = [rehypeFadeNewWords];
const WORKSPACE_FILE_DOWNLOAD_PATH = "/api/v1/files/download";
const WORKSPACE_FILE_OBJECT_URL_REVOKE_DELAY_MS = 5 * 60 * 1000;

export function AssistantMessageRenderer(props: Parameters<typeof AssistantMessageBody>[0]) {
  return (
    <div
      className={cn(
        "mc-assistant-renderer mc-assistant-renderer-markdown",
        props.running ? "mc-assistant-renderer-running" : "",
        `mc-assistant-stream-${props.streamPresentationMode ?? "smooth"}`,
        props.className,
      )}
    >
      <AssistantMessageContainer role={props.role} content={props.content} running={props.running}>
        <AssistantMessageBody {...props} />
      </AssistantMessageContainer>
    </div>
  );
}

export function AssistantMessageBody({
  role,
  content,
  running = false,
  streamPresentationMode = "smooth",
  streamTurnId,
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
  // Smooth mode reveals a streaming reply at a steady pace; the paced text is always a prefix of `content`.
  // Timed reveal is motion too, so a reduced-motion preference shows text as it arrives.
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pacedContent = useSteadyStreamText(
    content,
    role === "assistant" && running && streamPresentationMode === "smooth" && !reducedMotion,
  );
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
    return normalizeAssistantDisplayTextIncremental(normalizeStateRef.current, pacedContent);
  }, [role, content, pacedContent, running, streamTurnId]);

  return role === "assistant" && running ? (
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
  );
}

// Message headings belong to the message, not the page: an assistant "# Title" must not compete with the page's
// own h1 in the document outline. The element (and so its styling) is kept; only the announced level drops by two.
const MESSAGE_HEADING_LEVEL_OFFSET = 2;
function messageHeading(level: 1 | 2 | 3 | 4 | 5 | 6): NonNullable<Components["h1"]> {
  const Tag = `h${level}` as const;
  return function MessageHeading({ node: _node, ...props }) {
    return <Tag {...props} aria-level={Math.min(6, level + MESSAGE_HEADING_LEVEL_OFFSET)} />;
  };
}
const MESSAGE_HEADINGS = {
  h1: messageHeading(1),
  h2: messageHeading(2),
  h3: messageHeading(3),
  h4: messageHeading(4),
  h5: messageHeading(5),
  h6: messageHeading(6),
} satisfies Components;

function createMarkdownComponents({ allowGeneratedUi }: { allowGeneratedUi: boolean }): Components {
  return {
    ...MESSAGE_HEADINGS,
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
      // `$$` math (see remark-math) and a ```math fence, as GitHub reads it.
      if (language === "math") {
        return <ChatMathFormula tex={content.replace(/\n$/, "")} display={!/\bmath-inline\b/.test(className ?? "")} />;
      }
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

  // Sentences a model fenced (often a draft to copy) read as wrapped text; the Copy button stays.
  const isProse = isProseFence(language, trimmed);
  const idleCopyLabel = isProse ? "Copy text" : "Copy code";
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : idleCopyLabel;

  const copyButton = (
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
  );

  if (isProse) {
    return (
      <div className="mc-assistant-code-shell mc-assistant-prose-fence" data-language={language ?? undefined}>
        <div className="mc-assistant-code-header">
          <span className="mc-assistant-code-language">text</span>
          {copyButton}
        </div>
        <div className="mc-assistant-prose-fence-body">{trimmed}</div>
      </div>
    );
  }

  const codeBlock = (
    <div className="mc-assistant-code-shell" data-language={language ?? undefined}>
      <div className="mc-assistant-code-header">
        <span className="mc-assistant-code-language">{language ?? "code"}</span>
        {copyButton}
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
  fadeNewWords = false,
}: {
  content: string;
  role: "user" | "assistant";
  components: Components;
  tree?: Root;
  /** The streaming tail in Smooth mode: new words fade in. */
  fadeNewWords?: boolean;
}) {
  const plugins = useMemo(
    () =>
      tree
        ? [
            remarkGfm,
            MATH_PLUGIN,
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
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={fadeNewWords ? FADE_NEW_WORDS_PLUGINS : undefined}
        components={components}
      >
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
              fadeNewWords={streamPresentationMode === "smooth"}
            />
          </AssistantStreamingTailContext.Provider>
        </div>
      ) : null}
      <span className="mc-assistant-streaming-cursor" aria-hidden="true" />
    </div>
  );
}
