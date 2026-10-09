// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptPackLibraryPanel } from "./PromptPackLibraryPanel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("prompt-pack library panel", () => {
  it("groups the pack buttons without claiming list semantics it cannot satisfy", async () => {
    await act(async () =>
      root.render(
        <PromptPackLibraryPanel
          isOpsVariant={false}
          packs={[
            { packId: "p-1", name: "Pack one", testCount: 3 },
            { packId: "p-2", name: "Pack two", testCount: 1 },
          ]}
          selectedPackId="p-1"
          onSelectPack={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[role="list"]')).toBeNull();
    const group = container.querySelector('[role="group"][aria-label="Prompt packs"]')!;
    expect(group.querySelectorAll("button")).toHaveLength(2);
  });
});
