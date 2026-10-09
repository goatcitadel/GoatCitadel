// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A renderer that throws on a partial streamed program and renders once the program is complete.
vi.mock("./OpenUiStructuredBlock", () => ({
  canRenderOpenUiStructuredBlock: () => true,
  OpenUiStructuredBlockRenderer: ({ source }: { source: string }) => {
    if (source.endsWith("(")) throw new Error("unexpected end of program");
    return <p>Structured block: {source}</p>;
  },
}));

import { LazyOpenUiStructuredBlock } from "./LazyOpenUiStructuredBlock";

let root: Root;
let container: HTMLDivElement;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const block = (source: string) => <LazyOpenUiStructuredBlock source={source} fallback={<pre>code {source}</pre>} />;

describe("OpenUI block boundary", () => {
  it("shows the code block when the renderer throws, and reports why", async () => {
    await act(async () => root.render(block("Card(")));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(container.textContent).toBe("code Card(");
    expect(String(warn.mock.calls[0]?.[0])).toContain("OpenUI block");
  });

  it("reports a block that keeps failing while it streams only once", async () => {
    for (const source of ["Card(", "Card(a(", "Card(a(b("]) {
      await act(async () => root.render(block(source)));
    }
    await vi.waitFor(() => expect(container.textContent).toBe("code Card(a(b("));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("upgrades to the rendered block once the streamed source becomes renderable", async () => {
    await act(async () => root.render(block("Card(")));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await act(async () => root.render(block("Card()")));
    await vi.waitFor(() => expect(container.textContent).toBe("Structured block: Card()"));
  });
});
