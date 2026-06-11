// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOptionalStableHandler, useStableHandler } from "./useStableHandler";

describe("useStableHandler", () => {
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

  it("keeps a stable identity across renders while invoking the latest handler", () => {
    const captured: Array<(value: string) => string> = [];
    function Harness({ handler }: { handler: (value: string) => string }) {
      captured.push(useStableHandler(handler));
      return null;
    }

    const first = vi.fn((value: string) => `first:${value}`);
    const second = vi.fn((value: string) => `second:${value}`);
    act(() => {
      root?.render(<Harness handler={first} />);
    });
    act(() => {
      root?.render(<Harness handler={second} />);
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toBe(captured[1]);
    expect(captured[1]!("x")).toBe("second:x");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");
  });

  it("preserves undefined through useOptionalStableHandler and stays stable when defined", () => {
    const captured: Array<((value: number) => void) | undefined> = [];
    function Harness({ handler }: { handler: ((value: number) => void) | undefined }) {
      captured.push(useOptionalStableHandler(handler));
      return null;
    }

    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    act(() => {
      root?.render(<Harness handler={undefined} />);
    });
    act(() => {
      root?.render(<Harness handler={firstHandler} />);
    });
    act(() => {
      root?.render(<Harness handler={secondHandler} />);
    });

    expect(captured[0]).toBeUndefined();
    expect(captured[1]).toBeDefined();
    expect(captured[1]).toBe(captured[2]);
    captured[2]!(7);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith(7);
  });
});
