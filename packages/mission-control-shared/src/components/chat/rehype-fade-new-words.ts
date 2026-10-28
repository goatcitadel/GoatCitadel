// Adapted from hob's rehypeFadeWords (https://github.com/FrigadeHQ/hob, MIT, Copyright (c) 2026 Frigade).

/** The class each streamed word carries; styles fade it in once, when its element first mounts. */
export const STREAMING_WORD_CLASS = "mc-assistant-streaming-word";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Code keeps its own text nodes: the highlighter and copy button read them as written.
const SKIP_TAGS = new Set(["code", "pre"]);

function wrapWords(node: HastNode): HastNode {
  if (!node.children || (node.tagName && SKIP_TAGS.has(node.tagName))) return node;
  const children = node.children.flatMap((child): HastNode[] => {
    if (child.type !== "text" || !child.value) return [wrapWords(child)];
    return child.value
      .split(/(\s+)/)
      .filter(Boolean)
      .map((part) =>
        /^\s+$/.test(part)
          ? { type: "text", value: part }
          : {
              type: "element",
              tagName: "span",
              properties: { className: [STREAMING_WORD_CLASS] },
              children: [{ type: "text", value: part }],
            },
      );
  });
  return { ...node, children };
}

/**
 * While a reply streams, every word of the still-arriving tail is its own span. React keeps the spans already on
 * screen, so only new words animate in: a soft trailing edge instead of text popping in. Settled blocks are
 * rendered without it, so long conversations carry no extra spans.
 */
export function rehypeFadeNewWords() {
  return (tree: HastNode) => wrapWords(tree);
}
