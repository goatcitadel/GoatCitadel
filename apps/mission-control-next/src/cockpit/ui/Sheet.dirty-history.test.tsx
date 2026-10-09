// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CockpitNavigationProvider } from "../app/CockpitNavigationProvider";
import { useCockpitRoute } from "../app/use-cockpit-route";
import { readCockpitLocation } from "../app/cockpit-back-guard";
import { __resetSessionDraftsForTests, useSessionDraft } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";
import { Sheet } from "./Sheet";
vi.unmock("vaul");

const selected = "/work/tasks/selected?shell=cockpit&workspaceId=scope%3Aa#draft";
let root: Root, container: HTMLDivElement;
const here = () => window.location.pathname + window.location.search + window.location.hash;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
const dialog = (name: string) => [...document.querySelectorAll('[role="dialog"][data-state="open"]')].find(node => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent === name);
async function settle() {
  await act(async () => (window as unknown as HappyDomWindow).happyDOM.waitUntilComplete());
}
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); await settle(); }
function Editor() {
  const draft = useSessionDraft("sheet-dirty-history-editor", "Saved title", 1, { label: "Task title" });
  return <><label>Title<input value={draft.value} onInput={event => draft.setValue(event.currentTarget.value)} /></label>
    <button type="button" onClick={() => draft.setValue("Unsent title")}>Edit title</button></>;
}
function Harness() {
  const route = useCockpitRoute(), [open, setOpen] = useState(false), [nested, setNested] = useState(false);
  return <><h1>{route.pathname === "/work" ? "Work list" : "Selected task"}</h1>
    <button type="button" onClick={() => route.navigate(selected)}>Select task</button>
    {route.pathname === "/work/tasks/selected" ? <Editor /> : null}
    <button type="button" onClick={() => setOpen(true)}>Open sheet</button>
    <Sheet open={open} onOpenChange={setOpen} title="More"><button type="button" onClick={() => setNested(true)}>Open nested sheet</button></Sheet>
    <Sheet open={nested} onOpenChange={setNested} title="Nested sheet"><p>Nested content</p></Sheet></>;
}
beforeEach(async () => {
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  window.history.replaceState(null, "", "/work?shell=cockpit");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<StrictMode><UiPreferencesProvider><CockpitNavigationProvider><Harness /></CockpitNavigationProvider></UiPreferencesProvider></StrictMode>));
  await click("Select task"); await click("Edit title");
});
afterEach(async () => {
  vi.restoreAllMocks(); await act(async () => root.unmount()); await settle(); container.remove();
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
});
function preserved() {
  expect(here()).toBe(selected);
  expect(container.querySelector("h1")?.textContent).toBe("Selected task");
  expect(container.querySelector("input")?.value).toBe("Unsent title");
}
async function cancelThenContinue() {
  await act(async () => window.history.back()); await settle();
  expect(dialog("Unsaved changes")).toBeTruthy(); preserved();
  await click("Cancel"); preserved();
  await act(async () => window.history.back()); await settle();
  expect(dialog("Unsaved changes")).toBeTruthy();
  await click("Keep draft and close");
  expect(here()).toBe("/work?shell=cockpit"); expect(container.querySelector("h1")?.textContent).toBe("Work list");
  expect(dialog("Unsaved changes")).toBeFalsy();
  await act(async () => window.history.forward()); await settle();
  // The retained editor draft still owns the existing leave review if it is
  // active; no write/selection owner is replaced by this history fixture.
  if (dialog("Unsaved changes")) await click("Keep draft and close");
  preserved();
}
it.each([false, true])("skipped-base Back closes only the top sheet before the existing dirty route review (nested=%s)", async nested => {
  const state = structuredClone(window.history.state);
  await click("Open sheet");
  if (nested) await click("Open nested sheet");
  await act(async () => window.history.go(nested ? -3 : -2)); await settle();
  preserved(); expect(dialog("Nested sheet")).toBeFalsy();
  if (nested) { expect(dialog("More")).toBeTruthy(); await act(async () => window.history.back()); await settle(); }
  expect(dialog("More")).toBeFalsy(); expect(window.history.state).toEqual(state);
  await cancelThenContinue();
});
it("does not silently follow an unrelated route while explicit sheet cleanup is awaiting its landing", async () => {
  await click("Open sheet");
  const go = window.history.go.bind(window.history), requested: number[] = [];
  const deferred = vi.spyOn(window.history, "go").mockImplementation(delta => { requested.push(delta ?? 0); });
  await click("Close sheet");
  expect(requested).toEqual([-1]);
  // Deliver an unrelated traversal before the outstanding cleanup's base landing.
  await act(async () => go(-2));
  expect(readCockpitLocation().pathname).toBe("/work/tasks/selected");
  expect(container.querySelector("h1")?.textContent).toBe("Selected task");
  expect(requested.at(-1)).toBe(1);
  await act(async () => go(1)); await settle(); deferred.mockRestore();
  preserved(); await cancelThenContinue();
});
it("discards only through the existing global review and continues once, with canonical input on Forward", async () => {
  await click("Open sheet");
  await act(async () => window.history.go(-2)); await settle(); preserved();
  await act(async () => window.history.back()); await settle();
  expect(dialog("Unsaved changes")).toBeTruthy(); await click("Cancel"); preserved();
  await act(async () => window.history.back()); await settle();
  await click("Discard changes");
  expect(here()).toBe("/work?shell=cockpit"); expect(container.querySelector("h1")?.textContent).toBe("Work list");
  expect(dialog("Unsaved changes")).toBeFalsy();
  await act(async () => window.history.forward()); await settle();
  expect(here()).toBe(selected); expect(container.querySelector("input")?.value).toBe("Saved title");
});
