// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatToolRunSummary, TOOL_SUMMARY_COLLAPSE_CHARS } from "./ChatToolRunSummary";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("shows a short summary in full with no toggle", async () => {
  await act(async () => root.render(<ChatToolRunSummary text="Opened the page." />));
  expect(host.textContent).toBe("Opened the page.");
  expect(host.querySelector("button")).toBeNull();
});

it("collapses long tool output to a preview and expands it on request", async () => {
  const pageText = "Trail notes. ".repeat(Math.ceil(TOOL_SUMMARY_COLLAPSE_CHARS / 10));
  await act(async () => root.render(<ChatToolRunSummary text={pageText} />));
  const preview = host.querySelector("p")!;
  const toggle = host.querySelector("button")!;
  expect(preview.className).toContain("line-clamp-2");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toBe("Show full output");

  await act(async () => preview.click());
  expect(host.querySelector("p")!.className).not.toContain("line-clamp-2");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  await act(async () => toggle.click());
  expect(host.querySelector("p")!.className).toContain("line-clamp-2");
  expect(toggle.textContent).toBe("Show full output");
});
