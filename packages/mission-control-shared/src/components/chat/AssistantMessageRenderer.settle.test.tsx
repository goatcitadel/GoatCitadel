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

describe("canSettleInBlocks", () => {
  it("is false for link reference definitions and footnotes, true otherwise", () => {
    expect(canSettleInBlocks("See [docs].\n\n[docs]: https://example.invalid")).toBe(false);
    expect(canSettleInBlocks("A note[^1].\n\n[^1]: Text")).toBe(false);
    expect(canSettleInBlocks("Plain.\n\nSecond.")).toBe(true);
  });
});
