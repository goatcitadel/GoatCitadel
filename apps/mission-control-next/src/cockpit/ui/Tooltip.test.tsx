// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton";

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
  vi.useRealTimers();
});

const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')!;
const tooltipText = () => document.querySelector('[role="tooltip"]')?.textContent;

describe("IconButton tooltip", () => {
  it("has no native title and shows its name on keyboard focus (U-GL-016)", async () => {
    await act(async () => root.render(<IconButton label="Collapse sidebar" icon={<span />} />));
    expect(button().hasAttribute("title")).toBe(false);
    await act(async () => button().focus());
    await vi.waitFor(() => expect(tooltipText()).toBe("Collapse sidebar"));
  });

  it("opens after a 500 ms touch long-press and not before", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<IconButton label="Collapse sidebar" icon={<span />} />));
    const event = new Event("pointerdown", { bubbles: true });
    Object.assign(event, { pointerType: "touch", button: 0 });
    await act(async () => {
      button().dispatchEvent(event);
      vi.advanceTimersByTime(400);
    });
    expect(tooltipText()).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(tooltipText()).toBe("Collapse sidebar");
  });

  it("a touch tap that ends before 500 ms does not open it", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<IconButton label="Collapse sidebar" icon={<span />} />));
    const down = new Event("pointerdown", { bubbles: true });
    Object.assign(down, { pointerType: "touch", button: 0 });
    await act(async () => {
      button().dispatchEvent(down);
      button().dispatchEvent(new Event("pointerup", { bubbles: true }));
      vi.advanceTimersByTime(800);
    });
    expect(tooltipText()).toBeUndefined();
  });
});
