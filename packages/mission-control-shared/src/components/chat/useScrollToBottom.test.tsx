// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useScrollToBottom,
  type ScrollToBottomContentSignals,
  type UseScrollToBottomResult,
} from "./useScrollToBottom";

function baseSignals(overrides: Partial<ScrollToBottomContentSignals> = {}): ScrollToBottomContentSignals {
  return {
    sessionId: "session-1",
    threadTurnCount: 1,
    latestTurnId: "turn-1",
    latestTraceStatus: "completed",
    noticeCount: 0,
    queuedCount: 0,
    streamStatus: "idle",
    selectedTurnId: "turn-1",
    streamError: null,
    ...overrides,
  };
}

let latest: UseScrollToBottomResult | null = null;

function Harness({
  followOutput,
  onBottomStateChange,
  signals,
}: {
  followOutput: boolean;
  onBottomStateChange: (atBottom: boolean) => void;
  signals: ScrollToBottomContentSignals;
}) {
  const result = useScrollToBottom({ followOutput, onBottomStateChange, signals });
  latest = result;
  return (
    <div ref={result.scrollRef} className="scroll" onScroll={result.handleThreadScroll}>
      <div ref={result.threadEndRef} aria-hidden="true" />
    </div>
  );
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

describe("useScrollToBottom", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(props: {
    followOutput: boolean;
    onBottomStateChange: (atBottom: boolean) => void;
    signals: ScrollToBottomContentSignals;
  }) {
    act(() => {
      root?.render(<Harness {...props} />);
    });
  }

  it("reports near-bottom proximity from the scroll handler and only fires on change", () => {
    const onBottomStateChange = vi.fn();
    render({ followOutput: false, onBottomStateChange, signals: baseSignals() });
    const scrollElement = container?.querySelector(".scroll") as HTMLElement;

    // Far from the bottom -> not at bottom.
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 100, clientHeight: 400 });
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);
    const callsAfterFirst = onBottomStateChange.mock.calls.length;

    // A second scroll while still far away must NOT re-fire the identical value.
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(onBottomStateChange.mock.calls.length).toBe(callsAfterFirst);

    // Within the 80px threshold -> at bottom (an actual transition fires once).
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 760, clientHeight: 400 });
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
  });

  it("auto-follows new content while followOutput is true, pinning to the end via rAF", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onBottomStateChange = vi.fn();

    render({ followOutput: true, onBottomStateChange, signals: baseSignals() });
    scrollIntoView.mockClear();
    onBottomStateChange.mockClear();

    // New content arrives (turn count grows) while pinned -> re-pins to the end.
    render({
      followOutput: true,
      onBottomStateChange,
      signals: baseSignals({ threadTurnCount: 2, latestTurnId: "turn-2" }),
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
  });

  it("scrolls synchronously to the end when requestAnimationFrame is unavailable", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    vi.stubGlobal("requestAnimationFrame", undefined);
    const onBottomStateChange = vi.fn();

    render({ followOutput: true, onBottomStateChange, signals: baseSignals() });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
  });

  it("jumps to the latest content and marks the timeline at the bottom", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    const onBottomStateChange = vi.fn();

    render({ followOutput: false, onBottomStateChange, signals: baseSignals() });
    const scrollElement = container?.querySelector(".scroll") as HTMLElement;
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 100, clientHeight: 400 });
    act(() => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    onBottomStateChange.mockClear();
    scrollIntoView.mockClear();

    act(() => {
      latest?.jumpToLatest();
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
  });

  it("wires the bottom sentinel observer and reports intersection state", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class FakeIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observerCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver as unknown as typeof IntersectionObserver);

    const onBottomStateChange = vi.fn();
    render({ followOutput: false, onBottomStateChange, signals: baseSignals() });
    const scrollElement = container?.querySelector(".scroll") as HTMLElement;
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 100, clientHeight: 400 });

    expect(observe).toHaveBeenCalledTimes(1);

    // Establish a not-at-bottom baseline so the next intersection is a real change.
    act(() => {
      observerCallback?.([{ isIntersecting: false }]);
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);
    onBottomStateChange.mockClear();

    // Sentinel scrolls into view -> reports at-bottom.
    act(() => {
      observerCallback?.([{ isIntersecting: true }]);
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
  });

  it("disconnects the observer and cancels a pending follow frame on unmount", async () => {
    const disconnect = vi.fn();
    class FakeIntersectionObserver {
      observe = vi.fn();
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn();
      constructor(_callback: unknown) {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 99),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    render({ followOutput: true, onBottomStateChange: vi.fn(), signals: baseSignals() });

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(disconnect).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(99);
  });
});
