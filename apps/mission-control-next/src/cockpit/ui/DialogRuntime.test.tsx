// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DialogRuntime } from "./DialogRuntime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

it("puts each dialog and its scrim in one layer, newest last (U-GL-042)", async () => {
  await act(async () => {
    root.render(
      <DialogRuntime open onOpenChange={() => undefined} title="Memory item">
        <DialogRuntime open onOpenChange={() => undefined} title="Forget memory">
          <p>Sure?</p>
        </DialogRuntime>
      </DialogRuntime>,
    );
  });
  const layers = [...document.querySelectorAll("[data-cockpit-dialog-layer]")];
  expect(layers).toHaveLength(2);
  expect(layers[0]!.compareDocumentPosition(layers[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const layer of layers) {
    expect(layer.className).toContain("z-50");
    expect(layer.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  }
  expect(layers[1]!.textContent).toContain("Forget memory");
});
