// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageRenderer, canSettleInBlocks } from "./AssistantMessageRenderer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT = "First paragraph.\n\nSecond paragraph.\n\n";

describe("a finished streamed answer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(running: boolean, content = CONTENT) {
    act(() => {
      root.render(<AssistantMessageRenderer role="assistant" content={content} running={running} streamTurnId="t1" />);
    });
  }

  it("keeps its rendered blocks and drops the cursor and streaming tail when it finishes", () => {
    render(true);
    const first = container.querySelector("p");
    expect(first?.textContent).toBe("First paragraph.");
    expect(container.querySelector(".mc-assistant-streaming-cursor")).not.toBeNull();

    render(false);
    expect(container.querySelector("p")).toBe(first);
    expect(container.querySelector(".mc-assistant-streaming-cursor")).toBeNull();
    expect(container.querySelector(".mc-assistant-streaming-tail")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders content with a link reference definition as one block", () => {
    const content = "See [docs].\n\n[docs]: https://example.invalid\n";
    render(false, content);
    expect(container.querySelector(".mc-assistant-streaming-markdown")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid");
  });
});

describe("a finished streamed answer renders its last lines as final text", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Streams the content first, then finishes it, so the settled markup is what a finished turn shows.
  function settle(content: string): HTMLElement {
    act(() => {
      root.render(<AssistantMessageRenderer role="assistant" content={content} running streamTurnId="t2" />);
    });
    act(() => {
      root.render(<AssistantMessageRenderer role="assistant" content={content} running={false} streamTurnId="t2" />);
    });
    return container;
  }

  it("keeps every row of a table that ends the answer", () => {
    const view = settle("Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    expect(view.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(view.textContent).toContain("3");
  });

  it("keeps a one-line paragraph that starts with a pipe", () => {
    const view = settle("Intro.\n\n| not a table");
    expect(view.textContent).toContain("| not a table");
  });

  it("links a bare URL that ends the answer", () => {
    const view = settle("Read https://example.invalid/page");
    expect(view.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/page");
  });

  it("leaves a trailing unmatched bold marker literal", () => {
    const view = settle("Intro.\n\nThis is **not closed");
    expect(view.querySelector("strong")).toBeNull();
    expect(view.textContent).toContain("**");
  });

  it("renders the same blocks as the plain finished renderer for a mixed document", () => {
    const content = [
      "# Title",
      "",
      "Text with [a link](https://example.invalid) and **bold**.",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Last line https://example.invalid/end",
    ].join("\n");
    // Only the line breaks between block elements may differ; every element and attribute must match.
    const blocks = (view: ParentNode) =>
      [...view.querySelectorAll(".mc-assistant-markdown")]
        .map((node) => node.innerHTML)
        .join("")
        .replace(/>\s+</g, "><");
    const settled = blocks(settle(content));
    act(() => root.render(<AssistantMessageRenderer role="assistant" content={content} />));
    expect(settled).toBe(blocks(container));
  });
});

describe("canSettleInBlocks", () => {
  it("is false for link reference definitions and footnotes, true otherwise", () => {
    expect(canSettleInBlocks("See [docs].\n\n[docs]: https://example.invalid")).toBe(false);
    expect(canSettleInBlocks("A note[^1].\n\n[^1]: Text")).toBe(false);
    expect(canSettleInBlocks("Plain.\n\nSecond.")).toBe(true);
  });
});
