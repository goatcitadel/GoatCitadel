import { create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unified } from "unified";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

const counts = vi.hoisted(() => ({ sources: [] as string[], markdownSources: [] as string[] }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      counts.markdownSources.push(props.children ?? "");
      return createElement(actual.default, props);
    },
  };
});
beforeEach(() => {
  // Observe the real processor, including ReactMarkdown's dependency imports.
  const prototype = Object.getPrototypeOf(unified) as { parse(file?: unknown): unknown };
  const parse = prototype.parse;
  vi.spyOn(prototype, "parse").mockImplementation(function (this: unknown, file) {
    const result = parse.call(this, file);
    // ReactMarkdown's retained-tree provider accepts no source and returns an
    // existing AST. Count grammar work separately from that pipeline dispatch.
    if ((this as { parser: (...arguments_: unknown[]) => unknown }).parser.length > 0)
      counts.sources.push(String(file ?? ""));
    return result;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("SF6 Markdown work counts", () => {
  it("measures parsing separately from the splitter scan", () => {
    const cases = {
      paragraphs: Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with **formatting**.\n\n`),
      longLine: Array.from({ length: 20 }, () => "x".repeat(128)),
      fence: ["```ts\n", ...Array.from({ length: 20 }, () => "const value = 1;\n".repeat(5)), "```\n\nTail"],
      table: ["| Name | Value |\n| --- | --- |\n", ...Array.from({ length: 20 }, (_, i) => `| Row ${i} | Value |\n`)],
    };
    const results: Record<
      string,
      {
        parses: number;
        parsedCharacters: number;
        markdownRenders: number;
        markdownCharacters: number;
        finalCharacters: number;
      }
    > = {};
    for (const [name, chunks] of Object.entries(cases)) {
      counts.sources = [];
      counts.markdownSources = [];
      const renderer = create(<AssistantMessageRenderer role="assistant" content="" running streamTurnId={name} />);
      let content = "";
      for (const chunk of chunks) {
        content += chunk;
        renderer.update(<AssistantMessageRenderer role="assistant" content={content} running streamTurnId={name} />);
      }
      results[name] = {
        parses: counts.sources.length,
        parsedCharacters: counts.sources.reduce((sum, source) => sum + source.length, 0),
        markdownRenders: counts.markdownSources.length,
        markdownCharacters: counts.markdownSources.reduce((sum, source) => sum + source.length, 0),
        finalCharacters: content.length,
      };
      expect(renderer.toJSON()).not.toBeNull();
      renderer.unmount();
    }
    // This is deterministic parser work, not an elapsed-time or scan-counter claim.
    expect(results.paragraphs!.parses).toBeGreaterThan(0);
    if (process.env.GOATCITADEL_SF6_BASELINE_MEASUREMENTS !== "true") {
      expect(results.paragraphs!.parsedCharacters).toBeLessThan(2000);
      expect(results.paragraphs!.markdownCharacters).toBeLessThan(2000);
    }
    process.stdout.write(`SF6 Markdown parsing ${JSON.stringify(results)}\n`);
  });

  it("does not parse retained blocks when a tail or independent block arrives", () => {
    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content={"Completed first.\n\nMutable second.\nMore"}
        running
        streamTurnId="retain"
      />,
    );
    try {
      counts.sources = [];
      renderer.update(
        <AssistantMessageRenderer
          role="assistant"
          content={"Completed first.\n\nMutable second.\nMore tail"}
          running
          streamTurnId="retain"
        />,
      );
      expect(counts.sources).toHaveLength(1);
      expect(counts.sources[0]).not.toContain("Completed first.");
      counts.sources = [];
      renderer.update(
        <AssistantMessageRenderer
          role="assistant"
          content={"Completed first.\n\nMutable second.\nMore tail\n\nIndependent third.\n"}
          running
          streamTurnId="retain"
        />,
      );
      expect(counts.sources).toHaveLength(1);
      expect(counts.sources[0]).not.toContain("Completed first.");
    } finally {
      renderer.unmount();
    }
  });
});
