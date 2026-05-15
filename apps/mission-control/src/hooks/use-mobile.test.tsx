import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

function Harness({ onValue }: { onValue: (value: boolean) => void }) {
  const value = useIsMobile();
  onValue(value);
  return <span>{value ? "mobile" : "desktop"}</span>;
}

function installViewport(width: number) {
  const listeners = new Set<() => void>();
  const addEventListener = vi.fn((_event: string, listener: () => void) => listeners.add(listener));
  const removeEventListener = vi.fn((_event: string, listener: () => void) => listeners.delete(listener));
  vi.stubGlobal("window", {
    innerWidth: width,
    matchMedia: vi.fn(() => ({ addEventListener, removeEventListener })),
  });

  return {
    listeners,
    removeEventListener,
    setWidth(nextWidth: number) {
      (window as Window & { innerWidth: number }).innerWidth = nextWidth;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("useIsMobile", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("starts in desktop mode and tracks viewport changes below the mobile breakpoint", () => {
    const viewport = installViewport(1024);
    const values: boolean[] = [];

    renderer = create(<Harness onValue={(value) => values.push(value)} />);
    expect(values.at(-1)).toBe(false);

    act(() => {
      viewport.setWidth(500);
    });

    expect(values.at(-1)).toBe(true);
    renderer.unmount();
    renderer = null;
    expect(viewport.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("starts in mobile mode when the initial viewport is below the breakpoint", () => {
    installViewport(767);
    const values: boolean[] = [];

    renderer = create(<Harness onValue={(value) => values.push(value)} />);

    expect(values.at(-1)).toBe(true);
  });
});
