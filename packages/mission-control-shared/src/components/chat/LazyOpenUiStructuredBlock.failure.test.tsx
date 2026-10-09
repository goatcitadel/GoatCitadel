// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A renderer chunk that cannot load (for example a stale hashed chunk after a redeploy).
vi.mock("./OpenUiStructuredBlock", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { LazyOpenUiStructuredBlock } from "./LazyOpenUiStructuredBlock";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("lazy OpenUI structured block when the renderer cannot load", () => {
  it("keeps the plain code block instead of failing the message", async () => {
    await act(async () =>
      root.render(
        <section>
          <LazyOpenUiStructuredBlock source="Card()" fallback={<pre>code</pre>} />
          <p>rest of the message</p>
        </section>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe("coderest of the message");
    // The boundary caught the failed load (not a Suspense fallback still waiting), and reported it.
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("OpenUI block");
  });
});
