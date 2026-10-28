import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { healStreamingMarkdownTail } from "./streaming-markdown-heal";
import { createIncrementalSplitState, splitIncremental } from "./streaming-markdown";

describe("healStreamingMarkdownTail", () => {
  it.each([
    ["Next up: **bold", "Next up: **bold**"],
    ["Some *italic", "Some *italic*"],
    ["A ~~struck", "A ~~struck~~"],
    ["Run `npm i", "Run `npm i`"],
    ["**very ", "**very** "],
    ["**done*", "**done**"],
    ["***both", "***both***"],
    ["Next up: **", "Next up: "],
    ["See [the docs](https://exa", "See the docs"],
    ["See [the do", "See the do"],
  ])("makes %j whole as %j", (input, expected) => {
    expect(healStreamingMarkdownTail(input)).toBe(expected);
  });

  it.each(["2 * 3 = 6", "* a bullet", "**closed** text", "Run `a*b` now", "Plain words."])(
    "leaves %j as written",
    (input) => {
      expect(healStreamingMarkdownTail(input)).toBe(input);
    },
  );

  it("leaves brackets inside code alone", () => {
    expect(healStreamingMarkdownTail("Use `arr[` to start indexing.")).toBe("Use `arr[` to start indexing.");
    expect(healStreamingMarkdownTail("Run `arr[0")).toBe("Run `arr[0`");
    expect(healStreamingMarkdownTail("See `a[b]` and [the do")).toBe("See `a[b]` and the do");
  });

  it("only touches the paragraph still being written", () => {
    expect(healStreamingMarkdownTail("An *open\n\nNow **bold")).toBe("An *open\n\nNow **bold**");
  });
});

function textOf(node: Root | RootContent): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return "children" in node ? node.children.map((child) => textOf(child as RootContent)).join("") : "";
}

function hasType(node: Root | RootContent, type: string): boolean {
  return (
    node.type === type || ("children" in node && node.children.some((child) => hasType(child as RootContent, type)))
  );
}

describe("splitIncremental tail healing", () => {
  it("shows an unclosed bold as bold without changing the stored tail", () => {
    const state = createIncrementalSplitState();
    const content = "First paragraph.\n\nNext up: **bold";
    const split = splitIncremental(state, content);
    expect(split.stable + split.tail).toBe(content);
    expect(hasType(state.tailTree, "strong")).toBe(true);
    expect(textOf(state.tailTree)).not.toContain("**");
  });

  it("leaves a tail inside an open code block alone", () => {
    const state = createIncrementalSplitState();
    splitIncremental(state, "```js\nconst a = **b");
    expect(hasType(state.tailTree, "strong")).toBe(false);
    expect(textOf(state.tailTree)).toContain("**b");
  });
});
