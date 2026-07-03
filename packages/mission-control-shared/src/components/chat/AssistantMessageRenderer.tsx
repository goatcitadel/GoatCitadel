import { memo, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { normalizeAssistantDisplayText } from "./assistant-display-text";
import { AssistantStreamingTailContext, HighlightedCode } from "./HighlightedCode";
import {
  canRenderOpenUiStructuredBlock,
  isGoatOpenUiRendererEnabled,
  OpenUiStructuredBlockRenderer,
} from "./OpenUiStructuredBlock";

export type AssistantStreamPresentationMode = "smooth" | "instant";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

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

  if (allowGeneratedUi && isOpenUiBlock && isGoatOpenUiRendererEnabled() && canRenderOpenUiStructuredBlock(trimmed)) {
    return <OpenUiStructuredBlockRenderer source={trimmed} />;
  }

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
        <HighlightedCode code={trimmed} language={language} codeClassName={codeClassName} codeProps={codeProps} />
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
  streamTurnId,
}: {
  content: string;
  streamPresentationMode: AssistantStreamPresentationMode;
  // Identifies the streaming turn so the incremental parser state is reset when a new
  // message starts (fence-state must never leak across messages).
  streamTurnId?: string;
}) {
  // Carry the forward-scan split state across tokens of the same streaming turn so each
  // delta only scans the newly-appended characters (amortized O(delta) instead of an
  // O(n) full rescan per token, i.e. O(n^2) cumulative). The state is reset when the turn
  // id changes (fence-state must never leak across messages); splitIncremental also
  // self-heals on any non-append delta. Output stays byte-identical to
  // splitStreamingMarkdown(content) for every prefix.
  const splitStateRef = useRef<IncrementalSplitState | undefined>(undefined);
  const splitTurnRef = useRef<string | undefined>(undefined);
  const { stable, tail } = useMemo(() => {
    if (splitStateRef.current === undefined || splitTurnRef.current !== streamTurnId) {
      splitStateRef.current = createIncrementalSplitState();
      splitTurnRef.current = streamTurnId;
    }
    return splitIncremental(splitStateRef.current, content);
  }, [content, streamTurnId]);
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
          <AssistantStreamingTailContext.Provider value={true}>
            <MemoizedMarkdownBlock content={tail} role="assistant" components={assistantMarkdownComponents} />
          </AssistantStreamingTailContext.Provider>
        </div>
      ) : null}
      <span className="mc-assistant-streaming-cursor" aria-hidden="true" />
    </div>
  );
}

export function splitStreamingMarkdown(content: string): { stable: string; tail: string } {
  // Single forward pass: walk the content line by line, tracking whether we are
  // inside a ``` / ~~~ fence, and record the index just past the most recent
  // "\n\n" paragraph boundary that occurs while NOT inside a fence. This yields
  // the same split point as scanning every boundary backward and testing fence
  // balance of the prefix, but in O(n) instead of O(n^2).
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  let bestSplitEnd = -1;
  let lineStart = 0;

  for (let index = 0; index <= content.length; index += 1) {
    const atLineEnd = index === content.length || content[index] === "\n";
    if (!atLineEnd) {
      continue;
    }
    const line = content.slice(lineStart, index);
    const marker = parseMarkdownFenceMarker(line);
    if (marker) {
      const markerChar = marker.char;
      if (!inFence) {
        if (!hasSameLineStreamingFenceClose(line, markerChar, marker.length, marker.start + marker.length)) {
          inFence = true;
          fenceChar = markerChar;
          fenceLength = marker.length;
        }
      } else {
        const markerTail = line.slice(marker.start + marker.length);
        if (markerChar === fenceChar && marker.length >= fenceLength && markerTail.trim().length === 0) {
          inFence = false;
          fenceChar = null;
          fenceLength = 0;
        }
      }
    }
    // A "\n\n" boundary exists when the current line is empty and preceded by a
    // newline (i.e. content[index - 1] === "\n"). The boundary char index is
    // index - 1; the split point includes both newlines (index - 1 + 2 === index + 1).
    if (!inFence && index < content.length && content[index] === "\n" && index > 0 && content[index - 1] === "\n") {
      const paragraphIndex = index - 1;
      if (paragraphIndex > 0) {
        bestSplitEnd = paragraphIndex + 2;
      }
    }
    lineStart = index + 1;
  }

  if (bestSplitEnd <= 0) {
    return { stable: "", tail: content };
  }
  return {
    stable: content.slice(0, bestSplitEnd),
    tail: content.slice(bestSplitEnd),
  };
}

function parseMarkdownFenceMarker(line: string): { char: "`" | "~"; length: number; start: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[2]!;
  return {
    char: marker[0] as "`" | "~",
    length: marker.length,
    start: match[1]!.length,
  };
}

function hasSameLineStreamingFenceClose(
  line: string,
  fenceChar: "`" | "~",
  fenceLength: number,
  searchStart: number,
): boolean {
  for (let index = searchStart; index <= line.length - fenceLength; index += 1) {
    if (line[index] !== fenceChar) {
      continue;
    }
    let markerLength = 0;
    while (line[index + markerLength] === fenceChar) {
      markerLength += 1;
    }
    if (markerLength >= fenceLength && line.slice(index + markerLength).trim().length === 0) {
      return true;
    }
    index += Math.max(0, markerLength - 1);
  }
  return false;
}

// --- Incremental streaming split -------------------------------------------------
//
// `splitStreamingMarkdown` above is a single O(n) forward pass, but a streaming
// message calls it once per token on the *whole* accumulated string, so the cost is
// O(1) + O(2) + ... + O(n) = O(n^2) cumulative over a long answer. The engine below
// carries the forward-scan state across tokens of the SAME message so each delta only
// processes the characters appended since the last newline-terminated line — turning
// the cumulative cost into O(n) (amortized O(delta) per token).
//
// Equivalence guarantee: `splitIncremental` returns a value byte-identical to
// `splitStreamingMarkdown(content)` for every prefix of the stream. This is safe
// because the from-scratch scan is backtrack-free for the split point:
//   * `bestSplitEnd` only ever advances at an *interior* "\n\n" (the second newline at
//     index < content.length, i.e. inside a completed, immutable line) and only while
//     NOT inside a fence.
//   * `inFence` at any completed newline is fully determined by the bytes before it,
//     which never change under append — so a boundary finalized while outside a fence
//     can never be retroactively re-interpreted as inside one.
//   * The partial trailing line (processed at EOF) can flip fence state but, by the
//     boundary condition, can NEVER update `bestSplitEnd`. So we never need to re-scan
//     it to get the split; we only resume from the last newline.
// If a delta is ever NOT a pure append of the previous content (prefix mismatch or a
// shorter string), the engine resets and rescans from scratch, so it can never diverge.

export interface IncrementalSplitState {
  /** Full content seen on the previous push; used to detect non-append deltas. */
  content: string;
  /** Resume index: position just after the last newline-terminated line. Bytes before
   *  this are finalized line-wise and are never re-scanned. */
  resumeIndex: number;
  /** Parser state captured at `resumeIndex` (after all complete lines before it). */
  inFence: boolean;
  fenceChar: "`" | "~" | null;
  fenceLength: number;
  /** Best split end locked in from completed lines so far (-1 if none). */
  bestSplitEnd: number;
  /** Index from which the most recent push began its scan (for perf instrumentation). */
  lastScanStart: number;
}

export function createIncrementalSplitState(): IncrementalSplitState {
  return {
    content: "",
    resumeIndex: 0,
    inFence: false,
    fenceChar: null,
    fenceLength: 0,
    bestSplitEnd: -1,
    lastScanStart: 0,
  };
}

/**
 * Advance the carried split state with the latest accumulated `content` and return the
 * same `{ stable, tail }` shape as `splitStreamingMarkdown`. Mutates `state` in place.
 */
export function splitIncremental(state: IncrementalSplitState, content: string): { stable: string; tail: string } {
  // Detect a non-append delta (new message, edit, retry, or any shrink) and reset.
  if (content.length < state.content.length || !content.startsWith(state.content)) {
    state.resumeIndex = 0;
    state.inFence = false;
    state.fenceChar = null;
    state.fenceLength = 0;
    state.bestSplitEnd = -1;
  }

  let { inFence, fenceChar, fenceLength, bestSplitEnd } = state;
  let lineStart = state.resumeIndex;
  const scanStart = state.resumeIndex;
  state.lastScanStart = scanStart;

  // Resume point for the NEXT push: position after the last newline-terminated line.
  let nextResumeIndex = state.resumeIndex;
  let nextInFence = inFence;
  let nextFenceChar = fenceChar;
  let nextFenceLength = fenceLength;
  let nextBestSplitEnd = bestSplitEnd;

  for (let index = scanStart; index <= content.length; index += 1) {
    const atLineEnd = index === content.length || content[index] === "\n";
    if (!atLineEnd) {
      continue;
    }
    const line = content.slice(lineStart, index);
    const marker = parseMarkdownFenceMarker(line);
    if (marker) {
      const markerChar = marker.char;
      if (!inFence) {
        if (!hasSameLineStreamingFenceClose(line, markerChar, marker.length, marker.start + marker.length)) {
          inFence = true;
          fenceChar = markerChar;
          fenceLength = marker.length;
        }
      } else {
        const markerTail = line.slice(marker.start + marker.length);
        if (markerChar === fenceChar && marker.length >= fenceLength && markerTail.trim().length === 0) {
          inFence = false;
          fenceChar = null;
          fenceLength = 0;
        }
      }
    }
    if (!inFence && index < content.length && content[index] === "\n" && index > 0 && content[index - 1] === "\n") {
      const paragraphIndex = index - 1;
      if (paragraphIndex > 0) {
        bestSplitEnd = paragraphIndex + 2;
      }
    }
    lineStart = index + 1;
    // Only newline-terminated lines (index < length) are immutable; the EOF "line" is a
    // still-growing partial that the next token may extend, so we must NOT advance the
    // resume point past it. Snapshot state strictly at completed newlines.
    if (index < content.length) {
      nextResumeIndex = index + 1;
      nextInFence = inFence;
      nextFenceChar = fenceChar;
      nextFenceLength = fenceLength;
      nextBestSplitEnd = bestSplitEnd;
    }
  }

  state.content = content;
  state.resumeIndex = nextResumeIndex;
  state.inFence = nextInFence;
  state.fenceChar = nextFenceChar;
  state.fenceLength = nextFenceLength;
  state.bestSplitEnd = nextBestSplitEnd;

  if (bestSplitEnd <= 0) {
    return { stable: "", tail: content };
  }
  return {
    stable: content.slice(0, bestSplitEnd),
    tail: content.slice(bestSplitEnd),
  };
}

export async function copyTextToClipboard(content: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable in this environment. Copy requires navigator.clipboard.writeText().");
  }
  await navigator.clipboard.writeText(content);
}
