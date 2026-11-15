// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SheetDrawerRuntime } from "./SheetDrawerRuntime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.unmock("vaul");
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderSheet({ side, title = "Filters" }: { side: boolean; title?: string }) {
  await act(async () => {
    root.render(
      <SheetDrawerRuntime
        open
        onOpenChange={() => undefined}
        onOpenAutoFocus={undefined}
        onCloseAutoFocus={undefined}
        sdkClose={createRef<HTMLButtonElement>()}
        closeLabel="Close"
        title={title}
        side={side}
      >
        <p>Body</p>
      </SheetDrawerRuntime>,
    );
  });
}

it("keeps the title and close button outside the scrolling body (U-GL-029)", async () => {
  await renderSheet({ side: false, title: "Filters" });
  const header = document.querySelector("[data-sheet-header]")!;
  expect(header.textContent).toContain("Filters");
  expect(header.querySelector('button[aria-label="Close"]')).not.toBeNull();
  expect(document.querySelector(".cockpit-sheet-scroll [data-sheet-header]")).toBeNull();
  expect(document.querySelector(".cockpit-sheet-scroll")?.textContent).toContain("Body");
});

it("keeps the header outside the scroller on a side sheet too", async () => {
  await renderSheet({ side: true, title: "Filters" });
  const header = document.querySelector("[data-sheet-header]")!;
  expect(header.textContent).toContain("Filters");
  expect(header.parentElement?.querySelector(":scope > .overflow-y-auto")?.textContent).toContain("Body");
});

it("draws a drag handle on the bottom sheet only", async () => {
  await renderSheet({ side: false });
  expect(document.querySelector("[data-vaul-handle]")).not.toBeNull();
  await act(async () => root.render(<></>));
  await renderSheet({ side: true });
  expect(document.querySelector("[data-vaul-handle]")).toBeNull();
});

it("does not close the sheet when its drag handle is tapped", async () => {
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <SheetDrawerRuntime
        open
        onOpenChange={onOpenChange}
        onOpenAutoFocus={undefined}
        onCloseAutoFocus={undefined}
        sdkClose={createRef<HTMLButtonElement>()}
        closeLabel="Close"
        title="Filters"
        side={false}
      >
        <p>Body</p>
      </SheetDrawerRuntime>,
    );
  });
  await act(async () => document.querySelector<HTMLElement>("[data-vaul-handle]")!.click());
  await act(async () => new Promise((done) => setTimeout(done, 400)));
  expect(onOpenChange).not.toHaveBeenCalled();
});
