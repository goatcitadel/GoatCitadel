import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIsMobile } from "./use-mobile";

function Harness({ onValue }: { onValue: (value: boolean) => void }) {
  const value = useIsMobile();
  onValue(value);
  return <span>{value ? "mobile" : "desktop"}</span>;
}

describe("useIsMobile", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    vi.unstubAllGlobals();
  });

  it("tracks the configured mobile breakpoint and removes listeners", () => {
    const listeners = new Set<() => void>();
    const addEventListener = vi.fn((_event: string, listener: () => void) => listeners.add(listener));
    const removeEventListener = vi.fn((_event: string, listener: () => void) => listeners.delete(listener));
    vi.stubGlobal("window", {
      innerWidth: 1024,
      matchMedia: vi.fn(() => ({ addEventListener, removeEventListener })),
    });

    const values: boolean[] = [];
    renderer = create(<Harness onValue={(value) => values.push(value)} />);
    expect(values.at(-1)).toBe(false);

    act(() => {
      (window as Window & { innerWidth: number }).innerWidth = 500;
      for (const listener of listeners) {
        listener();
      }
    });
    expect(values.at(-1)).toBe(true);

    renderer.unmount();
    renderer = null;
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
