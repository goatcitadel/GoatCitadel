// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useOverflowEdges } from "./use-overflow-edges";

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

function Probe() {
  const { ref, start, end } = useOverflowEdges<HTMLDivElement>([]);
  return <div ref={ref} data-probe data-overflow-start={start || undefined} data-overflow-end={end || undefined} />;
}

it("marks the side that hides more tabs (U-CH-048)", async () => {
  await act(async () => root.render(<Probe />));
  const probe = container.querySelector<HTMLElement>("[data-probe]")!;
  expect(probe.hasAttribute("data-overflow-end")).toBe(false);
  Object.defineProperty(probe, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(probe, "clientWidth", { configurable: true, value: 300 });
  await act(async () => probe.dispatchEvent(new Event("scroll")));
  expect(probe.hasAttribute("data-overflow-end")).toBe(true);
  expect(probe.hasAttribute("data-overflow-start")).toBe(false);
  probe.scrollLeft = 300;
  await act(async () => probe.dispatchEvent(new Event("scroll")));
  expect(probe.hasAttribute("data-overflow-start")).toBe(true);
  expect(probe.hasAttribute("data-overflow-end")).toBe(false);
});
