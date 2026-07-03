import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatToolDiffBlock } from "./ChatToolDiffBlock";

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

const SMALL_DIFF = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " unchanged", "-old", "+new"].join("\n");

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join("");
  }
  return "";
}

function findByClassName(renderer: ReactTestRenderer, className: string) {
  return renderer.root.findAll(
    (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes(className),
  );
}

describe("ChatToolDiffBlock", () => {
  beforeEach(() => {
    clipboardMocks.writeText.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardMocks.writeText } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the shell, pre, and per-line spans with kind classes", () => {
    const renderer = create(<ChatToolDiffBlock diff={SMALL_DIFF} />);
    expect(findByClassName(renderer, "mc-next-tool-diff-shell")).toHaveLength(1);
    const pre = renderer.root.findByType("pre");
    expect(pre.props.className).toBe("mc-next-tool-diff");
    expect(pre.props.tabIndex).toBe(0);

    const lineSpans = findByClassName(renderer, "line");
    expect(lineSpans).toHaveLength(6);
    expect(lineSpans.map((span) => span.props.className)).toEqual([
      "line meta",
      "line meta",
      "line hunk",
      "line ctx",
      "line del",
      "line add",
    ]);
    expect(textOf(lineSpans[4]!.props.children)).toBe("-old\n");
    expect(textOf(lineSpans[5]!.props.children)).toBe("+new\n");
  });

  it("does not render a truncation footer when nothing was truncated", () => {
    const renderer = create(<ChatToolDiffBlock diff={SMALL_DIFF} />);
    expect(findByClassName(renderer, "mc-next-tool-diff-more")).toHaveLength(0);
  });

  it("renders the truncation footer with the correct count when the diff exceeds maxLines", () => {
    const bodyLines = Array.from({ length: 10 }, (_, index) => `+line ${index}`);
    const diff = ["@@ -1,10 +1,10 @@", ...bodyLines].join("\n");
    const renderer = create(<ChatToolDiffBlock diff={diff} maxLines={3} />);
    const footer = findByClassName(renderer, "mc-next-tool-diff-more");
    expect(footer).toHaveLength(1);
    // 11 total lines, maxLines 3 -> 8 truncated
    expect(textOf(footer[0]!.props.children)).toBe("+8 more lines");
  });

  it("renders a copy button that copies the FULL diff, not the truncated view", async () => {
    const bodyLines = Array.from({ length: 10 }, (_, index) => `+line ${index}`);
    const diff = ["@@ -1,10 +1,10 @@", ...bodyLines].join("\n");
    const renderer = create(<ChatToolDiffBlock diff={diff} maxLines={2} />);
    const button = renderer.root.findByType("button");
    await act(async () => {
      button.props.onClick();
      await Promise.resolve();
    });
    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMocks.writeText).toHaveBeenCalledWith(diff);
  });

  it("has no aria-live attribute anywhere in the tree", () => {
    const renderer = create(<ChatToolDiffBlock diff={SMALL_DIFF} />);
    const withAriaLive = renderer.root.findAll((node) => node.props?.["aria-live"] !== undefined);
    expect(withAriaLive).toHaveLength(0);
  });
});
