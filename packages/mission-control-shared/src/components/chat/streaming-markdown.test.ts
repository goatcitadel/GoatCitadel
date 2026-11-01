import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { createIncrementalSplitState, splitIncremental, splitStreamingMarkdown } from "./streaming-markdown";
import { healStreamingMarkdownTail } from "./streaming-markdown-heal";

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

function withoutLastBlock(tree: Root): Root {
  return { ...tree, children: tree.children.slice(0, -1) };
}

function heldBackTableForms(source: string): unknown[] {
  const finishedLines = parser.parse(source.slice(0, source.lastIndexOf("\n") + 1));
  return [finishedLines, withoutLastBlock(finishedLines), withoutLastBlock(parser.parse(source))].map(semantic);
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
        // A half-written marker in the tail is shown healed (closed or hidden), unless the tail is inside code.
        const healed = split.stable + healStreamingMarkdownTail(split.tail);
        const forms = [semantic(parser.parse(source)), semantic(parser.parse(healed))];
        // A table still arriving shows only its finished lines, or nothing until a body row has finished.
        if (split.tail.includes("|")) forms.push(...heldBackTableForms(source));
        expect(forms, source).toContainEqual(semantic(tree));
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

describe("streaming tables", () => {
  const cellText = (node: { value?: string; children?: unknown[] }): string =>
    node.value ?? (node.children ?? []).map((child) => cellText(child as typeof node)).join("");
  const shown = (content: string) =>
    (() => {
      const state = createIncrementalSplitState();
      splitIncremental(state, content);
      return state.tailTree.children.map((node) =>
        node.type === "table"
          ? node.children.map((row) => row.children.map(cellText).join("|"))
          : `${node.type}:${cellText(node)}`,
      );
    })();

  it("shows no raw header pipes and no grid until the first body row has finished its line", () => {
    for (const content of [
      "| Name",
      "| Name | Speed |",
      "| Name | Speed |\n",
      "| Name | Speed |\n| --",
      "| Name | Speed |\n| --- | --- |",
      "| Name | Speed |\n| --- | --- |\n",
      "| Name | Speed |\n| --- | --- |\n|",
      "| Name | Speed |\n| --- | --- |\n| Loop A | sl",
    ]) {
      expect(shown(content), JSON.stringify(content)).toEqual([]);
    }
  });

  it("adds each row once its line has finished, never an empty or half-written row", () => {
    const head = "| Name | Speed |\n| --- | --- |\n| Loop **A** | slow |\n";
    expect(shown(head)).toEqual([["Name|Speed", "Loop A|slow"]]);
    expect(shown(`${head}|`)).toEqual([["Name|Speed", "Loop A|slow"]]);
    expect(shown(`${head}| Loop B | fa`)).toEqual([["Name|Speed", "Loop A|slow"]]);
    expect(shown(`${head}| Loop B | fast |\n`)).toEqual([["Name|Speed", "Loop A|slow", "Loop B|fast"]]);
  });

  it("leaves text that only mentions a pipe alone", () => {
    expect(shown("Use a | b in the shell")).toEqual(["paragraph:Use a | b in the shell"]);
    expect(shown("| pipes start this line\nand this one does not")).toEqual([
      "paragraph:| pipes start this line\nand this one does not",
    ]);
  });
});

describe("tail rewrites keep the committed blocks", () => {
  const prefix = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the reply.\n\n`).join("");

  function rewriteTail(before: string, after: string) {
    const state = createIncrementalSplitState();
    splitIncremental(state, before);
    const blocks = [...state.blocks];
    const resumeIndex = state.resumeIndex;
    const split = splitIncremental(state, after);
    return { state, blocks, resumeIndex, split };
  }

  it("re-parses only from the last commit point when a closed formula rewrites the tail", () => {
    const { state, blocks, resumeIndex, split } = rewriteTail(
      `${prefix}Final paragraph where $x`,
      `${prefix}Final paragraph where $$x$$ is`,
    );
    expect(resumeIndex).toBeGreaterThan(0);
    expect(state.lastScanStart).toBe(resumeIndex);
    expect(state.blocks).toHaveLength(blocks.length);
    blocks.forEach((block, i) => expect(state.blocks[i]).toBe(block));
    expect(split).toEqual(splitStreamingMarkdown(`${prefix}Final paragraph where $$x$$ is`));
  });

  it("forgets a reference definition that the rewritten tail no longer holds", () => {
    const head = `See [the spec][spec].\n\n${prefix}`;
    const { state, blocks, split } = rewriteTail(
      `${head}[spec]: https://example.com/spec\n\nTail where $x`,
      `${head}Tail where $$x$$ is`,
    );
    // The definition was the block that committed "Paragraph 39"; without it that paragraph is the tail's again.
    expect(state.blocks).toHaveLength(blocks.length - 1);
    state.blocks.forEach((block, i) => expect(block).toBe(blocks[i]));
    expect(state.definitionMap.has("spec")).toBe(false);
    expect(state.definitions).toEqual([]);
    expect(JSON.stringify(state.blocks[0]!.tree)).not.toContain("https://example.com/spec");
    expect(JSON.stringify(state.tailTree)).not.toContain("https://example.com/spec");
    expect(split).toEqual(splitStreamingMarkdown(`${head}Tail where $$x$$ is`));
  });

  it("keeps the committed blocks when the formula sits in a list item's continuation", () => {
    const after = `${prefix}1. Item\n    where $$x$$ is`;
    const { state, blocks, split } = rewriteTail(`${prefix}1. Item\n    where $x`, after);
    blocks.forEach((block, i) => expect(state.blocks[i]).toBe(block));
    expect(state.blocks).toHaveLength(blocks.length);
    expect(split).toEqual(splitStreamingMarkdown(after));
  });
});

describe("tail rewrites that reach back into the last committed block", () => {
  it("returns the last block to the tail when the rewrite changes the line that committed it", () => {
    const state = createIncrementalSplitState();
    splitIncremental(state, "Intro.\n\n- item\n\nAfter.\n");
    const [intro] = state.blocks;
    const after = "Intro.\n\n- item\n\n  continued in the item\n";
    const split = splitIncremental(state, after);
    expect(split).toEqual(splitStreamingMarkdown(after));
    expect(split.tail.startsWith("- item")).toBe(true);
    expect(state.blocks).toEqual([intro]);
    expect(state.blocks[0]).toBe(intro);
  });
});
