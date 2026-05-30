import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const displayTextMocks = vi.hoisted(() => ({
  real: undefined as ((content: string) => string) | undefined,
  normalizeAssistantDisplayText: vi.fn<(content: string) => string>((content) =>
    displayTextMocks.real ? displayTextMocks.real(content) : content,
  ),
}));

vi.mock("./assistant-display-text", async () => {
  const actual = await vi.importActual<typeof import("./assistant-display-text")>("./assistant-display-text");
  displayTextMocks.real = actual.normalizeAssistantDisplayText;
  return {
    ...actual,
    normalizeAssistantDisplayText: displayTextMocks.normalizeAssistantDisplayText,
  };
});

const { AssistantMessageRenderer, splitStreamingMarkdown } = await import("./AssistantMessageRenderer");

function htmlShapeOf(node: unknown): unknown {
  if (node === null || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(htmlShapeOf);
  }
  const { type, props, children } = node as {
    type?: unknown;
    props?: Record<string, unknown>;
    children?: unknown;
  };
  return {
    type,
    props: props ?? {},
    children: children === undefined ? undefined : htmlShapeOf(children),
  };
}

describe("AssistantMessageRenderer render-performance memoization", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    displayTextMocks.normalizeAssistantDisplayText.mockClear();
  });

  afterEach(() => {
    renderer?.unmount();
  });

  it("does not recompute normalized assistant text when re-rendered with identical content", () => {
    renderer = create(<AssistantMessageRenderer role="assistant" content="Stable assistant body" />);
    expect(displayTextMocks.normalizeAssistantDisplayText).toHaveBeenCalledTimes(1);

    // Re-render with byte-identical props (parent re-render / streaming no-op delta).
    renderer.update(<AssistantMessageRenderer role="assistant" content="Stable assistant body" />);
    renderer.update(<AssistantMessageRenderer role="assistant" content="Stable assistant body" />);
    expect(displayTextMocks.normalizeAssistantDisplayText).toHaveBeenCalledTimes(1);

    // Changing the content recomputes exactly once more.
    renderer.update(<AssistantMessageRenderer role="assistant" content="Stable assistant body extended" />);
    expect(displayTextMocks.normalizeAssistantDisplayText).toHaveBeenCalledTimes(2);
  });

  it("never normalizes user content through the assistant pipeline", () => {
    renderer = create(<AssistantMessageRenderer role="user" content="User text" />);
    renderer.update(<AssistantMessageRenderer role="user" content="User text" />);
    expect(displayTextMocks.normalizeAssistantDisplayText).not.toHaveBeenCalled();
  });

  it("keeps the stable streaming prefix byte-identical so only the tail re-parses on a delta", () => {
    const firstDelta = "First paragraph stays put.\n\nSecond paragraph is grow";
    const secondDelta = "First paragraph stays put.\n\nSecond paragraph is growing now.";

    const first = splitStreamingMarkdown(firstDelta);
    const second = splitStreamingMarkdown(secondDelta);

    // The stable prefix is identical across deltas -> the memoized stable block does not re-parse.
    expect(first.stable).toBe("First paragraph stays put.\n\n");
    expect(second.stable).toBe(first.stable);
    // Only the tail differs, so only the tail block re-parses.
    expect(first.tail).not.toBe(second.tail);
    expect(second.tail).toBe("Second paragraph is growing now.");
  });

  it("renders identical markup for representative content across re-renders", () => {
    const content = [
      "Intro paragraph with a [citation](https://example.com/ref).",
      "",
      "- first list item",
      "- second list item",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    renderer = create(<AssistantMessageRenderer role="assistant" content={content} />);
    const firstShape = JSON.stringify(htmlShapeOf(renderer.toJSON()));

    renderer.update(<AssistantMessageRenderer role="assistant" content={content} />);
    const secondShape = JSON.stringify(htmlShapeOf(renderer.toJSON()));

    expect(secondShape).toBe(firstShape);
    // Sanity: representative structures are present in the rendered markup.
    expect(firstShape).toContain("mc-assistant-code-block");
    expect(firstShape).toContain("https://example.com/ref");
    expect(firstShape).toContain('"ul"');
  });
});
