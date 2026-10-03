import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { createIncrementalSplitState, splitIncremental, splitStreamingMarkdown } from "./streaming-markdown";

const parser = unified().use(remarkParse).use(remarkGfm);
export const SEMANTIC_STREAM_FIXTURES = [
  "- First\n\n- Second\n\n  Continued paragraph.\n\nAfter.\n",
  "> First\n>\n> Second\n\n> Third\n\nAfter.\n",
  "Title\n------\n\nAfter.\n",
  "| Header | Value |\n| --- | --- |\n| Row | Wider value |\n| Escaped \\| | Safe |\n\nAfter.\n",
  "Intro.\n\n```md\n| Header | Value |\n| --- | --- |\n\nnot a table\n```\n\nAfter.\n",
  "Intro.\n\n~~~md\n- not a list\n\n> not a quote\n~~~\n\nAfter.\n",
  "Intro.\n\n    indented code\n\n    more code\n\nAfter.\n",
  "Intro.\n\n1. First\n\n2. Second\n   - nested\n\nAfter.\n",
];

function semantic(tree: Root): unknown {
  return JSON.parse(
    JSON.stringify(
      { type: "root", children: tree.children.filter((node) => node.type !== "definition") },
      (key, value) => (key === "position" ? undefined : value),
    ),
  );
}

describe("SF6 parser-derived boundaries", () => {
  it("matches the settled parser structure at every character and reconstructs exact source", () => {
    for (const full of SEMANTIC_STREAM_FIXTURES) {
      const state = createIncrementalSplitState();
      for (let i = 1; i <= full.length; i += 1) {
        const source = full.slice(0, i);
        const split = splitIncremental(state, source);
        expect(split.stable + split.tail).toBe(source);
        expect(split, source).toEqual(splitStreamingMarkdown(source));
        const tree: Root = {
          type: "root",
          children: [
            ...state.blocks.flatMap((block) => block.tree.children.filter((node) => node.type !== "definition")),
            ...state.tailTree.children,
          ],
        };
        expect(semantic(tree), source).toEqual(semantic(parser.parse(source)));
      }
    }
  });

  it("holds transformable last blocks and a half-arrived next-block opening", () => {
    for (const source of [
      "- One\n\n-",
      "> One\n\n>",
      "Heading\n---",
      "| A | B |\n| --- | --",
      "```ts\ncode\n\n",
      "~~~ts\ncode\n\n",
    ]) {
      expect(splitStreamingMarkdown(source).stable, source).toBe("");
    }
  });

  it("retains independent block ASTs and updates only real reference dependencies", () => {
    const state = createIncrementalSplitState();
    const prefix = "Plain paragraph.\n\nSee [the spec][SPEC].\n\n`[other]` and \\[escaped].\n\nTail.\n";
    splitIncremental(state, prefix);
    const originals = state.blocks.map((block) => block.tree);
    splitIncremental(state, prefix + "\n[SPEC]: https://example.com/spec\n\nNext.\n");
    expect(state.blocks[0]!.tree).toBe(originals[0]);
    expect(state.blocks[1]!.tree).not.toBe(originals[1]);
    expect(state.blocks[2]!.tree).toBe(originals[2]);
    expect(JSON.stringify(state.blocks[1]!.tree)).toContain("https://example.com/spec");
    const known = state.blocks.map((block) => block.tree);
    splitIncremental(state, state.content + "\n[unused]: https://example.com/unused\n\nNext again.\n");
    known.forEach((tree, i) => expect(state.blocks[i]!.tree).toBe(tree));
  });

  it("honors first definitions, multiline titles, escaped labels and scoped reset", () => {
    const state = createIncrementalSplitState();
    splitIncremental(state, 'See [spec][a\\]b].\n\n[a\\]b]: https://example.com/first\n  "Title"\n\nNext.\n');
    expect([...state.definitionMap.values()][0]?.node.title).toBe("Title");
    splitIncremental(state, state.content + "\n[a\\]b]: https://example.com/duplicate\n\nNext again.\n");
    expect([...state.definitionMap.values()][0]?.node.url).toBe("https://example.com/first");
    splitIncremental(state, "New turn.\n\nTail.\n");
    expect(state.definitionMap.size).toBe(0);
    expect(state.blocks.map((block) => block.source).join("")).not.toContain("spec");
    splitIncremental(state, "New");
    expect(state.blocks).toHaveLength(0);
  });

  it("never publishes an incomplete reference destination or bare URL as a link", () => {
    const state = createIncrementalSplitState();
    const full = "See [spec][spec].\n\n[spec]: https://example.com/spec";
    for (let i = 1; i <= full.length; i += 1) {
      splitIncremental(state, full.slice(0, i));
      expect(state.definitionMap.size).toBe(0);
    }
    splitIncremental(state, full + "\n");
    expect(state.definitionMap.get("spec")?.node.url).toBe("https://example.com/spec");
    splitIncremental(state, "https://example.com/par");
    expect(JSON.stringify(state.tailTree)).toContain('"url":""');
  });

  it("bounds retention to this message and releases it on replacement", () => {
    const state = createIncrementalSplitState();
    const content = Array.from({ length: 600 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
    const split = splitIncremental(state, content);
    expect(state.blocks).toHaveLength(512);
    expect(split.stable + split.tail).toBe(content);
    splitIncremental(state, "Replacement");
    expect(state.blocks).toHaveLength(0);
  });
});
