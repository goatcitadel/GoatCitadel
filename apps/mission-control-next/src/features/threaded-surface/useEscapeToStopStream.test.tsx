// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEscapeToStopStream } from "./useEscapeToStopStream";

function Harness({ enabled, onStop }: { enabled: boolean; onStop: () => void }) {
  useEscapeToStopStream({ enabled, onStop });
  return null;
}

function dispatchEscape(target: EventTarget, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...overrides });
  target.dispatchEvent(event);
  return event;
}

describe("useEscapeToStopStream", () => {
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
  });

  it("calls onStop and prevents the default action on a plain Escape keydown when enabled", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    let event!: KeyboardEvent;
    act(() => {
      event = dispatchEscape(document);
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not call onStop when disabled", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled={false} onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(document);
    });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("does not call onStop when the Escape event is already defaultPrevented (a capture-phase handler already won)", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    // Simulate a capture-phase handler (e.g. ThreadedSurfacePage's rail/dock Escape
    // handlers) that already called event.preventDefault() before the non-capture
    // listener below would see it. Register our own capture-phase interceptor to
    // preventDefault ahead of the hook's document-level (bubble-phase) listener.
    const interceptor = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", interceptor, { capture: true });

    act(() => {
      dispatchEscape(document);
    });

    expect(onStop).not.toHaveBeenCalled();
    document.removeEventListener("keydown", interceptor, { capture: true });
  });

  it("does not call onStop while composing (IME candidate window open)", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(document, { isComposing: true } as Partial<KeyboardEventInit>);
    });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("does not call onStop when the event target is inside a role=dialog element", () => {
    const onStop = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const innerButton = document.createElement("button");
    dialog.appendChild(innerButton);
    document.body.appendChild(dialog);

    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(innerButton);
    });

    expect(onStop).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("calls onStop for a target outside any role=dialog even when a dialog exists elsewhere in the document", () => {
    const onStop = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(document.body);
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    dialog.remove();
  });

  it("removes the listener on unmount so a later Escape does not call onStop", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      root?.unmount();
    });

    act(() => {
      dispatchEscape(document);
    });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("removes the old listener and attaches a fresh one when deps change (does not double-call onStop)", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    // Flip `enabled` off then back on: this changes the effect's dependency, forcing a
    // teardown + re-attach. A leaked prior listener would double-invoke onStop below.
    act(() => {
      root?.render(<Harness enabled={false} onStop={onStop} />);
    });
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(document);
    });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Escape keys", () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    act(() => {
      dispatchEscape(document, { key: "Enter" });
    });

    expect(onStop).not.toHaveBeenCalled();
  });
});
