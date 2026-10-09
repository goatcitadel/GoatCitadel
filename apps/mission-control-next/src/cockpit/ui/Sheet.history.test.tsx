// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CockpitNavigationProvider } from "../app/CockpitNavigationProvider";
import { useCockpitNavigation } from "../app/cockpit-navigation-context";
import { Sheet } from "./Sheet";
vi.unmock("vaul");

let root: Root, container: HTMLDivElement;
const destination = "/settings/models?shell=cockpit&view=llamacpp#local-ai";
const here = () => window.location.pathname + window.location.search + window.location.hash;
function Harness() {
  const [open, setOpen] = useState(false), route = useCockpitNavigation();
  return <><button type="button" onClick={() => setOpen(true)}>Open sheet</button>
    <Sheet open={open} onOpenChange={setOpen} title="History proof"><p>Sheet body</p>
      <button type="button" onClick={() => route.navigate("/settings/connections#mcp-servers")}>Navigate from sheet</button>
    </Sheet></>;
}
beforeEach(async () => {
  window.history.replaceState(null, "", "/work");
  window.history.pushState({ retained: "original state" }, "", destination);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><UiPreferencesProvider><CockpitNavigationProvider><Harness /></CockpitNavigationProvider></UiPreferencesProvider></StrictMode>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
async function open() {
  await act(async () => { button("Open sheet").focus(); button("Open sheet").click(); });
  expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeTruthy();
}
it.each(["Back", "Close", "Escape"])("preserves route, history state and trigger focus on %s", async gesture => {
  const state = structuredClone(window.history.state); await open();
  await act(async () => {
    if (gesture === "Back") window.history.back();
    else if (gesture === "Close") button("Close sheet").click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeFalsy());
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Open sheet")));
  expect(here()).toBe(destination); expect(window.history.state).toEqual(state);
  await act(async () => window.history.back()); expect(here()).toBe("/work");
  await act(async () => window.history.forward()); expect(here()).toBe(destination);
});
it("uses the existing reviewed navigation owner after closing its history entry", async () => {
  await open();
  await act(async () => button("Navigate from sheet").click());
  await vi.waitFor(() => expect(here()).toBe("/settings/connections?shell=cockpit#mcp-servers"));
  await act(async () => window.history.back()); expect(here()).toBe(destination);
  await act(async () => window.history.back()); expect(here()).toBe("/work");
});
