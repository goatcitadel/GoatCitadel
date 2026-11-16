// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CockpitNavigationProvider } from "../app/CockpitNavigationProvider";
import { Dialog } from "./Dialog";
import { Sheet } from "./Sheet";
vi.unmock("vaul");

let root: Root, container: HTMLDivElement;
function Harness() {
  const [sheet, setSheet] = useState(false),
    [dialog, setDialog] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setSheet(true)}>
        Open sheet
      </button>
      <Sheet open={sheet} onOpenChange={setSheet} title="Memory item">
        <button type="button" onClick={() => setDialog(true)}>
          Forget memory
        </button>
      </Sheet>
      <Dialog open={dialog} onOpenChange={setDialog} title="Forget this memory?">
        <p>This cannot be undone.</p>
      </Dialog>
    </>
  );
}
beforeEach(async () => {
  window.history.replaceState(null, "", "/library?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <UiPreferencesProvider>
        <CockpitNavigationProvider>
          <Harness />
        </CockpitNavigationProvider>
      </UiPreferencesProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === name,
  )!;
const drawer = () => document.querySelector<HTMLElement>("[data-vaul-drawer]");
const layer = () => document.querySelector<HTMLElement>("[data-cockpit-dialog-layer]");

it("opens a dialog over a sheet, closes only the dialog on Escape and returns focus into the sheet", async () => {
  await act(async () => {
    button("Open sheet").focus();
    button("Open sheet").click();
  });
  await vi.waitFor(() => expect(drawer()?.getAttribute("data-state")).toBe("open"));
  await act(async () => {
    button("Forget memory").focus();
    button("Forget memory").click();
  });
  await vi.waitFor(() => expect(layer()).not.toBeNull());
  // The dialog layer is the later node in the document and sits at the same z-50 as the sheet, so it is on top.
  expect(drawer()!.compareDocumentPosition(layer()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(layer()!.className).toContain("z-50");
  expect(layer()!.textContent).toContain("Forget this memory?");
  await vi.waitFor(() => expect(layer()!.contains(document.activeElement)).toBe(true));

  await act(async () => {
    layer()!
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(layer()).toBeNull());
  expect(drawer()?.getAttribute("data-state")).toBe("open");
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Forget memory")));
});
