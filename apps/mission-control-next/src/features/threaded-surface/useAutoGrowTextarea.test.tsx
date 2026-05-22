// @vitest-environment happy-dom
/**
 * Verifies that useAutoGrowTextarea reads computed styles and scrollHeight
 * from the bound element and writes back element.style.height between the
 * configured min/max line bounds. The repo's testing stack is
 * react-test-renderer + jsdom; real layout is not computed, so we feed the
 * hook a hand-built textarea-shaped target whose scrollHeight is set per
 * scenario.
 */
import React, { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea";

type FakeTextarea = {
  style: { height: string; overflowY: string };
  scrollHeight: number;
};

function makeFakeTextarea(scrollHeight: number): FakeTextarea {
  return {
    style: { height: "", overflowY: "" },
    scrollHeight,
  };
}

function Harness({
  target,
  value,
  options,
}: {
  target: FakeTextarea;
  value: string;
  options?: Parameters<typeof useAutoGrowTextarea>[2];
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // react-test-renderer never mounts to real DOM; inject the fake target so
  // the hook's effect resolves the same element the assertions will check.
  ref.current = target as unknown as HTMLTextAreaElement;
  useAutoGrowTextarea(ref, value, options);
  return null;
}

function setupGetComputedStyleStub({
  lineHeight = "20px",
  fontSize = "14px",
  paddingTop = "0px",
  paddingBottom = "0px",
  borderTopWidth = "0px",
  borderBottomWidth = "0px",
}: Partial<Record<string, string>> = {}) {
  const stub = vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        lineHeight,
        fontSize,
        paddingTop,
        paddingBottom,
        borderTopWidth,
        borderBottomWidth,
      }) as unknown as CSSStyleDeclaration,
  );
  return stub;
}

function setupResizeObserverStub() {
  const observers: Array<{ disconnect: () => void }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return observers;
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    void act(() => {
      renderer?.unmount();
    });
    renderer = null;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAutoGrowTextarea", () => {
  it("floors the height at the min-line bound when content is shorter than min", async () => {
    setupResizeObserverStub();
    setupGetComputedStyleStub({ lineHeight: "20px" });
    const target = makeFakeTextarea(40); // 2 lines worth of content
    await act(async () => {
      renderer = create(<Harness target={target} value="short" options={{ minLines: 5, maxLines: 14 }} />);
    });
    // 5 lines * 20px = 100px floor
    expect(target.style.height).toBe("100px");
    expect(target.style.overflowY).toBe("hidden");
  });

  it("grows the height with content between min and max", async () => {
    setupResizeObserverStub();
    setupGetComputedStyleStub({ lineHeight: "20px" });
    const target = makeFakeTextarea(160); // 8 lines worth
    await act(async () => {
      renderer = create(<Harness target={target} value="medium" options={{ minLines: 5, maxLines: 14 }} />);
    });
    expect(target.style.height).toBe("160px");
    expect(target.style.overflowY).toBe("hidden");
  });

  it("caps the height at the max-line bound and engages internal scroll", async () => {
    setupResizeObserverStub();
    setupGetComputedStyleStub({ lineHeight: "20px" });
    const target = makeFakeTextarea(400); // 20 lines, well past max
    await act(async () => {
      renderer = create(<Harness target={target} value="long" options={{ minLines: 5, maxLines: 14 }} />);
    });
    // 14 lines * 20px = 280px ceiling
    expect(target.style.height).toBe("280px");
    expect(target.style.overflowY).toBe("auto");
  });

  it("accounts for padding and border when computing min and max", async () => {
    setupResizeObserverStub();
    setupGetComputedStyleStub({
      lineHeight: "20px",
      paddingTop: "4px",
      paddingBottom: "4px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
    });
    const target = makeFakeTextarea(40);
    await act(async () => {
      renderer = create(<Harness target={target} value="short" options={{ minLines: 5, maxLines: 14 }} />);
    });
    // 5 * 20 + 4 + 4 + 1 + 1 = 110
    expect(target.style.height).toBe("110px");
  });
});
