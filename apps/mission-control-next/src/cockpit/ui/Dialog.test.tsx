// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Dialog", () => {
  it("renders a named dialog and a close control", () => {
    act(() => { root.render(<Dialog open onOpenChange={vi.fn()} title="Command palette"><p>Body</p></Dialog>); });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Command palette");
    expect(dialog?.querySelector('button[aria-label="Close dialog"]')).not.toBeNull();
  });
});
