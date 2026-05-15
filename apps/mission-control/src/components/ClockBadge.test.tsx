// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockBadge } from "./ClockBadge";

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

describe("ClockBadge", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the current minute, refreshes on the interval, and clears the timer", () => {
    vi.setSystemTime(new Date("2026-05-14T09:05:00.000Z"));
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    renderer = create(<ClockBadge />);
    expect(JSON.stringify(renderer.toJSON())).toContain(timeLabel("2026-05-14T09:05:00.000Z"));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(JSON.stringify(renderer.toJSON())).toContain(timeLabel("2026-05-14T09:06:00.000Z"));

    renderer.unmount();
    renderer = null;
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
