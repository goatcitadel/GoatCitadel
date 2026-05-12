import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMediaQuery } from "./useMediaQuery";

function Harness({ query, onValue }: { query: string; onValue: (value: boolean) => void }) {
  const matches = useMediaQuery(query);
  onValue(matches);
  return <span>{matches ? "match" : "miss"}</span>;
}

describe("useMediaQuery", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
  });

  afterEach(() => {
    renderer?.unmount();
    vi.unstubAllGlobals();
  });

  it("returns false when matchMedia is unavailable", () => {
    vi.stubGlobal("window", {});
    const values: boolean[] = [];
    renderer = create(<Harness query="(min-width: 1px)" onValue={(value) => values.push(value)} />);
    expect(values.at(-1)).toBe(false);
  });

  it("subscribes to media query changes and removes the listener on unmount", () => {
    const listeners = new Set<(event?: MediaQueryListEvent) => void>();
    let matches = false;
    const addEventListener = vi.fn((_event: string, listener: (event?: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    });
    const removeEventListener = vi.fn((_event: string, listener: (event?: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    });
    const matchMedia = vi.fn((query: string) => ({
      media: query,
      matches,
      addEventListener,
      removeEventListener,
    }));
    vi.stubGlobal("window", { matchMedia });

    const values: boolean[] = [];
    renderer = create(<Harness query="(max-width: 800px)" onValue={(value) => values.push(value)} />);
    expect(values.at(-1)).toBe(false);
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    act(() => {
      matches = true;
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(values.at(-1)).toBe(true);

    renderer.update(<Harness query="(max-width: 1200px)" onValue={(value) => values.push(value)} />);
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1200px)");

    renderer.unmount();
    renderer = null;
    expect(removeEventListener).toHaveBeenCalled();
  });
});
