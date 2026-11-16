// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useScrollEdges } from "./use-scroll-edges";

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

const renders = { count: 0 };
function Probe() {
  renders.count += 1;
  const { ref, start, end } = useScrollEdges<HTMLDivElement>([]);
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

it("does not render again while the edges are unchanged", async () => {
  await act(async () => root.render(<Probe />));
  const probe = container.querySelector<HTMLElement>("[data-probe]")!;
  Object.defineProperty(probe, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(probe, "clientWidth", { configurable: true, value: 300 });
  await act(async () => probe.dispatchEvent(new Event("scroll")));
  // React may render once more before it settles on the unchanged state; after that scrolling costs no render.
  await act(async () => probe.dispatchEvent(new Event("scroll")));
  const settled = renders.count;
  for (let i = 0; i < 5; i += 1) await act(async () => probe.dispatchEvent(new Event("scroll")));
  expect(renders.count).toBe(settled);
});

it("measures a row that mounts after the hook's host did (the strip appears once a conversation opens)", async () => {
  function Late({ show }: { show: boolean }) {
    return show ? <Probe /> : <p>Nothing yet</p>;
  }
  await act(async () => root.render(<Late show={false} />));
  await act(async () => root.render(<Late show />));
  const probe = container.querySelector<HTMLElement>("[data-probe]")!;
  Object.defineProperty(probe, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(probe, "clientWidth", { configurable: true, value: 300 });
  await act(async () => probe.dispatchEvent(new Event("scroll")));
  expect(probe.hasAttribute("data-overflow-end")).toBe(true);
});
