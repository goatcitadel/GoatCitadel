// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AreaHeader } from "./AreaHeader";

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

it("the page description reads at the default interface size, one step below the title (U-GL-011)", async () => {
  await act(async () => root.render(<AreaHeader title="System" description="Health, spend and quality." />));
  const description = container.querySelector("header p")!;
  expect(description.className).toContain("text-base");
  expect(description.className).not.toContain("text-sm");
  expect(container.querySelector("h1")!.className).toContain("text-xl");
});
