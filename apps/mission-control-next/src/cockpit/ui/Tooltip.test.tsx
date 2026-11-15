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

describe("icon buttons inside layers that own Escape", () => {
  it("a focused icon button in a dialog shows no tooltip and one Escape closes the dialog", async () => {
    const { Dialog } = await import("./Dialog");
    const onOpenChange = vi.fn();
    await act(async () =>
      root.render(
        <Dialog
          open
          onOpenChange={onOpenChange}
          title="Inspector"
          actions={<IconButton label="Restore docked inspector" icon={<span />} />}
        >
          <p>Body</p>
        </Dialog>,
      ),
    );
    const restore = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('button[aria-label="Restore docked inspector"]');
      if (!found) throw new Error("dialog not loaded");
      return found;
    });
    await act(async () => restore.focus());
    expect(tooltipText()).toBeUndefined();
    await act(async () => {
      restore.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("outside a dialog, focus still shows the name", async () => {
    await act(async () => root.render(<IconButton label="Collapse sidebar" icon={<span />} />));
    await act(async () => button().focus());
    await vi.waitFor(() => expect(tooltipText()).toBe("Collapse sidebar"));
  });
});

describe("icon button tooltip details", () => {
  it("does not describe the button by its own name when the tooltip is open", async () => {
    await act(async () => root.render(<IconButton label="Collapse sidebar" icon={<span />} />));
    await act(async () => button().focus());
    await vi.waitFor(() => expect(tooltipText()).toBe("Collapse sidebar"));
    expect(button().hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps a described-by the caller gave", async () => {
    await act(async () => root.render(<IconButton label="Collapse sidebar" aria-describedby="note" icon={<span />} />));
    expect(button().getAttribute("aria-describedby")).toBe("note");
  });

  it("still shows the name of a disabled icon button on hover", async () => {
    await act(async () => root.render(<IconButton label="Collapse sidebar" disabled icon={<span />} />));
    const wrapper = button().parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    const move = new Event("pointermove", { bubbles: true });
    Object.assign(move, { pointerType: "mouse" });
    await act(async () => wrapper.dispatchEvent(move));
    await vi.waitFor(() => expect(tooltipText()).toBe("Collapse sidebar"));
  });
});
