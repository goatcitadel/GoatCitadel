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

it("every dialog title is a section title (text-lg) that can shrink beside the close button (U-GL-012)", async () => {
  await act(async () => {
    root.render(
      <DialogRuntime open onOpenChange={() => undefined} title="Forget this memory item and everything under it">
        <p>Sure?</p>
      </DialogRuntime>,
    );
  });
  const title = document.querySelector('[role="dialog"] h2')!;
  expect(title.className).toContain("text-lg");
  expect(title.className).toContain("wrap-anywhere");
  expect(title.className).not.toContain("text-md");
  expect(title.parentElement!.className).toContain("min-w-0");
});
