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

/**
 * useEscapeToStopStream defers its onStop decision into a `queueMicrotask`
 * callback so it can re-check `event.defaultPrevented` after every listener
 * on the same dispatch has run, regardless of registration order. A single
 * `await Promise.resolve()` after the synchronous dispatch is enough to flush
 * it: `queueMicrotask` and promise continuations share one microtask queue,
 * and the hook's callback was always enqueued first (during the dispatch,
 * which completes before this helper's `await` line runs).
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
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

  it("calls onStop once the dispatch settles when no other handler claims Escape", async () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    let event!: KeyboardEvent;
    await act(async () => {
      event = dispatchEscape(document);
      await flushMicrotasks();
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    // The hook itself no longer calls preventDefault: by the time its
    // deferred microtask would want to, the dispatch that produced this event
    // is already over, so there is nothing left downstream to suppress.
    expect(event.defaultPrevented).toBe(false);
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

  it("does not call onStop when the Escape event is already defaultPrevented (a capture-phase handler already won)", async () => {
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

    await act(async () => {
      dispatchEscape(document);
      await flushMicrotasks();
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

  it("calls onStop for a target outside any role=dialog even when a dialog exists elsewhere in the document", async () => {
    const onStop = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    await act(async () => {
      dispatchEscape(document.body);
      await flushMicrotasks();
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

  it("does not call onStop if the component unmounts between the keydown dispatch and the deferred microtask", async () => {
    const onStop = vi.fn();
    act(() => {
      root?.render(<Harness enabled onStop={onStop} />);
    });

    // Dispatch while still mounted: the guards pass and the hook schedules
    // its deferred onStop check, but does not resolve it yet.
    act(() => {
      dispatchEscape(document);
    });

    // Unmount before that microtask runs. The teardown must prevent the
    // now-pending microtask from acting on stale state (no onStop call after
    // the component — and whatever owns the stream — is gone).
    act(() => {
      root?.unmount();
    });

    await act(async () => {
      await flushMicrotasks();
    });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("removes the old listener and attaches a fresh one when deps change (does not double-call onStop)", async () => {
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

    await act(async () => {
      dispatchEscape(document);
      await flushMicrotasks();
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

  describe("registration-order independence", () => {
    /**
     * Both this hook's listener and a menu's own dismiss-Escape listener are
     * bubble-phase document listeners, so whichever registers first also
     * runs first on dispatch. Before this fix, useEscapeToStopStream decided
     * synchronously inside its own listener — correct only when it happened
     * to run AFTER the menu's listener (menu-opens-before-stream-starts).
     * When the stream started first, this hook's listener registered (and
     * therefore ran) first, calling onStop before the later menu listener
     * ever got a chance to claim the event. Deferring the decision to a
     * microtask that re-checks `event.defaultPrevented` after the full
     * dispatch fixes this regardless of which listener registered first.
     */
    it("does not call onStop when a bubble-phase listener registered AFTER this hook mounts claims the event (stream-starts-before-menu-opens ordering)", async () => {
      const onStop = vi.fn();
      act(() => {
        // This hook's listener registers first, simulating "the stream
        // started before any menu was open".
        root?.render(<Harness enabled onStop={onStop} />);
      });

      const menuPreventDefault = vi.fn();
      const menuHandler = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          menuPreventDefault();
          event.preventDefault();
        }
      };
      // Registers second, simulating "the operator opened a menu after the
      // stream had already started".
      document.addEventListener("keydown", menuHandler);

      await act(async () => {
        dispatchEscape(document);
        await flushMicrotasks();
      });

      expect(menuPreventDefault).toHaveBeenCalledTimes(1);
      expect(onStop).not.toHaveBeenCalled();

      document.removeEventListener("keydown", menuHandler);
    });

    it("still calls onStop when a bubble-phase listener registered after this hook mounts does not claim the event", async () => {
      const onStop = vi.fn();
      act(() => {
        root?.render(<Harness enabled onStop={onStop} />);
      });

      const passiveObserver = vi.fn();
      const passiveHandler = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          passiveObserver();
        }
      };
      document.addEventListener("keydown", passiveHandler);

      await act(async () => {
        dispatchEscape(document);
        await flushMicrotasks();
      });

      expect(passiveObserver).toHaveBeenCalledTimes(1);
      expect(onStop).toHaveBeenCalledTimes(1);

      document.removeEventListener("keydown", passiveHandler);
    });
  });
});
