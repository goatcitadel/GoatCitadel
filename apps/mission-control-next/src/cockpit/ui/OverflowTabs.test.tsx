// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverflowTabs } from "./OverflowTabs";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  media.phone = false;
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

const many = Array.from({ length: 8 }, (_, index) => ({
  id: "t" + index,
  label: "Tab " + index,
  href: "/lib/" + index,
}));

it("replaces a long strip with a section picker on a phone and navigates on change", async () => {
  media.phone = true;
  const navigate = vi.fn();
  await act(async () =>
    root.render(<OverflowTabs label="Library views" tabs={many} current="t2" navigate={navigate} />),
  );
  expect(container.querySelector("a")).toBeNull();
  const select = container.querySelector("select") as HTMLSelectElement;
  expect(select.value).toBe("/lib/2");
  expect(select.options).toHaveLength(8);
  await act(async () => {
    select.value = "/lib/5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(navigate).toHaveBeenCalledWith("/lib/5");
});

it("keeps the strip on wider screens and for short tab sets on a phone", async () => {
  await act(async () =>
    root.render(<OverflowTabs label="Library views" tabs={many} current="t2" navigate={vi.fn()} />),
  );
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelectorAll("a")).toHaveLength(8);
  media.phone = true;
  await act(async () =>
    root.render(<OverflowTabs label="Work views" tabs={tabs} current="board" navigate={vi.fn()} />),
  );
  expect(container.querySelector("select")).toBeNull();
});
