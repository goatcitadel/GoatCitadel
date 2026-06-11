// @vitest-environment happy-dom
import { act } from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useModalDialogBehavior } from "./useModalDialogBehavior";

function DialogHarness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useModalDialogBehavior({ open, onClose, containerRef });
  if (!open) {
    return null;
  }
  return (
    <div ref={containerRef} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

describe("useModalDialogBehavior", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    document.body.style.overflow = "";
  });

  const findButton = (label: string): HTMLButtonElement => {
    const match = [...document.querySelectorAll("button")].find((button) => button.textContent === label);
    if (!match) {
      throw new Error(`Button ${label} not found`);
    }
    return match;
  };

  it("locks body scroll and moves focus into the dialog while open, restoring both on close", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const onClose = vi.fn();
    act(() => {
      root?.render(<DialogHarness open onClose={onClose} />);
    });
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(findButton("first"));

    act(() => {
      root?.render(<DialogHarness open={false} onClose={onClose} />);
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(<DialogHarness open onClose={onClose} />);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab focus at the dialog edges", () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(<DialogHarness open onClose={onClose} />);
    });

    findButton("second").focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(findButton("first"));

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(findButton("second"));
  });

  it("pulls focus back into the dialog when it escapes the container", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    const onClose = vi.fn();
    act(() => {
      root?.render(<DialogHarness open onClose={onClose} />);
    });

    outside.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(findButton("first"));
    outside.remove();
  });
});
