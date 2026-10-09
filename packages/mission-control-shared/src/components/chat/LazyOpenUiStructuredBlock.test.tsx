// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openUi = vi.hoisted(() => ({ renderable: true }));
vi.mock("./OpenUiStructuredBlock", () => ({
  canRenderOpenUiStructuredBlock: () => openUi.renderable,
  OpenUiStructuredBlockRenderer: ({ source }: { source: string }) => <p>Structured block: {source}</p>,
}));

import { LazyOpenUiStructuredBlock } from "./LazyOpenUiStructuredBlock";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  openUi.renderable = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("lazy OpenUI structured block", () => {
  it("renders the structured block once the renderer loads", async () => {
    await act(async () => root.render(<LazyOpenUiStructuredBlock source="Card()" fallback={<pre>code</pre>} />));
    await vi.waitFor(() => expect(container.textContent).toBe("Structured block: Card()"));
  });

  it("keeps the plain code block when the source cannot be rendered", async () => {
    openUi.renderable = false;
    await act(async () => root.render(<LazyOpenUiStructuredBlock source="nonsense" fallback={<pre>code</pre>} />));
    await vi.waitFor(() => expect(container.textContent).toBe("code"));
  });

  it("is never loaded by the message renderer up front", () => {
    const renderer = readFileSync(path.join(__dirname, "AssistantMessageRenderer.tsx"), "utf8");
    expect(renderer).not.toMatch(/from "\.\/OpenUiStructuredBlock"/);
    expect(renderer).toMatch(/from "\.\/LazyOpenUiStructuredBlock"/);
  });
});
