import { createContext, useContext, useEffect, useState, type HTMLAttributes, type JSX, type ReactNode } from "react";
import type { Element as HastElement, Root as HastRoot, RootContent as HastRootContent } from "hast";

import { cn } from "../../lib/utils";
import {
  highlightCodeToHast,
  isAssistantCodeHighlightEnabled,
  loadAssistantCodeHighlighter,
  normalizeHighlightLanguage,
  HIGHLIGHT_MAX_CODE_CHARS,
} from "./assistant-code-highlight";

/**
 * Set to `true` around the streaming tail block only (see StreamingMarkdown in
 * AssistantMessageRenderer.tsx). Highlighting must never run for the streaming tail —
 * it re-renders on every token, so highlighting it would mean re-highlighting on every
 * delta instead of once per settled block.
 */
export const AssistantStreamingTailContext = createContext(false);

export function HighlightedCode({
  code,
  language,
  codeClassName,
  codeProps,
}: {
  code: string;
  language: string | undefined;
  codeClassName: string | undefined;
  codeProps: HTMLAttributes<HTMLElement>;
}): JSX.Element {
  const isStreamingTail = useContext(AssistantStreamingTailContext);
  const [tree, setTree] = useState<HastRoot | null>(null);

  useEffect(() => {
    if (isStreamingTail || !isAssistantCodeHighlightEnabled()) {
      return;
    }
    const normalizedLanguage = normalizeHighlightLanguage(language);
    if (normalizedLanguage === null) {
      return;
    }
    if (code.length > HIGHLIGHT_MAX_CODE_CHARS) {
      return;
    }
    let cancelled = false;
    loadAssistantCodeHighlighter()
      .then((highlighter) => {
        if (cancelled || highlighter === null) {
          return;
        }
        const nextTree = highlightCodeToHast(highlighter, code, normalizedLanguage);
        if (!cancelled && nextTree !== null) {
          setTree(nextTree);
        }
      })
      .catch(() => {
        // Intentionally a no-op: loadAssistantCodeHighlighter() is documented to
        // resolve null rather than reject, but a rejection here (e.g. a mocked or
        // replaced loader) must fall back to plain text instead of surfacing an
        // unhandled rejection or crashing the message renderer.
      });
    return () => {
      cancelled = true;
    };
  }, [code, isStreamingTail, language]);

  return (
    <code className={cn(codeClassName, tree ? "hljs" : undefined)} {...codeProps}>
      {tree ? renderHastNodes(tree.children) : code}
    </code>
  );
}

/**
 * Renders HAST nodes (as produced by lowlight) to React elements directly — no
 * dangerouslySetInnerHTML anywhere. `element` nodes become `<span>`s carrying only their
 * `className` (the highlight.js class taxonomy, e.g. `hljs-keyword`); `text` nodes become
 * plain strings; any other node type (e.g. `comment`) falls back to its own text content
 * so no content is ever silently dropped.
 */
function renderHastNodes(nodes: HastRootContent[]): ReactNode[] {
  return nodes.map((node, index) => renderHastNode(node, index));
}

function renderHastNode(node: HastRootContent, key: number): ReactNode {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element") {
    return (
      <span key={key} className={hastClassName(node)}>
        {renderHastNodes(node.children)}
      </span>
    );
  }
  // Fallback for any other hast node type (e.g. "comment"): render its literal text
  // content, if any, rather than dropping it silently.
  return hastNodeTextContent(node);
}

function hastClassName(element: HastElement): string | undefined {
  const raw = element.properties.className;
  if (Array.isArray(raw)) {
    return raw.join(" ");
  }
  if (typeof raw === "string") {
    return raw;
  }
  return undefined;
}

function hastNodeTextContent(node: HastRootContent): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  return "";
}
