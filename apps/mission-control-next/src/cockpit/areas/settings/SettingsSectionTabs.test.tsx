// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsSectionTabs } from "./SettingsSectionTabs";
import type { SettingsIndexPage } from "./settings-index";

vi.mock("./settings-controls", () => ({ preloadSettingsSection: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const page = {
  id: "citadel",
  label: "Citadel",
  entries: ["workspaces", "overview", "council", "wards", "vault"].map((section) => ({
    section,
    label: section,
    discoverable: true,
    releaseStatus: "ship",
  })),
} as unknown as SettingsIndexPage;

it("keeps the named Radix tablist and marks the side that hides more section tabs", async () => {
  await act(async () =>
    root.render(
      <SettingsSectionTabs page={page} value="workspaces" onChange={vi.fn()}>
        {(entry) => <p>{entry.label} controls</p>}
      </SettingsSectionTabs>,
    ),
  );
  const list = container.querySelector('[role="tablist"]') as HTMLElement;
  expect(list.getAttribute("aria-label")).toBe("Citadel sections");
  expect(list.querySelectorAll('[role="tab"]')).toHaveLength(5);
  expect(list.className).toContain("cockpit-overflow-fade");
  Object.defineProperty(list, "scrollWidth", { configurable: true, value: 700 });
  Object.defineProperty(list, "clientWidth", { configurable: true, value: 350 });
  await act(async () => list.dispatchEvent(new Event("scroll")));
  expect(list.hasAttribute("data-overflow-end")).toBe(true);
  expect(list.hasAttribute("data-overflow-start")).toBe(false);
  list.scrollLeft = 350;
  await act(async () => list.dispatchEvent(new Event("scroll")));
  expect(list.hasAttribute("data-overflow-start")).toBe(true);
  expect(list.hasAttribute("data-overflow-end")).toBe(false);
});
