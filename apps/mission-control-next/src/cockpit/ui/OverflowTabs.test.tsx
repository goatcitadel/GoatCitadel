// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverflowTabs } from "./OverflowTabs";

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

const tabs = [
  { id: "board", label: "Board", href: "/work" },
  { id: "history", label: "History", href: "/work/history" },
];

it("keeps the tabs as named links and marks the side that hides more tabs", async () => {
  const navigate = vi.fn();
  await act(async () =>
    root.render(<OverflowTabs label="Work views" tabs={tabs} current="history" navigate={navigate} />),
  );
  const nav = container.querySelector('nav[aria-label="Work views"]') as HTMLElement;
  expect(nav.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/work/history");
  Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: 300 });
  await act(async () => nav.dispatchEvent(new Event("scroll")));
  expect(nav.hasAttribute("data-overflow-end")).toBe(true);
  expect(nav.hasAttribute("data-overflow-start")).toBe(false);
  await act(async () => (nav.querySelector('a[href="/work"]') as HTMLAnchorElement).click());
  expect(navigate).toHaveBeenCalledWith("/work");
});
