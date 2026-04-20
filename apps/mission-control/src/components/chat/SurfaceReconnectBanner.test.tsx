import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceReconnectBanner } from "./SurfaceReconnectBanner";

afterEach(() => {
  vi.useRealTimers();
});

describe("SurfaceReconnectBanner", () => {
  it("renders reconnecting, restored, and failed states without stacking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    const onRefresh = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <SurfaceReconnectBanner
            status={{ state: "retrying", reconnectAttempts: 2, lastErrorAt: "2026-03-22T11:59:58.000Z" }}
            onRefresh={onRefresh}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Reconnecting live updates");

      await act(async () => {
        renderer.update(
          <SurfaceReconnectBanner
            status={{ state: "open", reconnectAttempts: 2, lastEventAt: "2026-03-22T12:00:01.000Z" }}
            onRefresh={onRefresh}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Live updates restored");

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(renderer.toJSON()).toBeNull();

      await act(async () => {
        renderer.update(
          <SurfaceReconnectBanner
            status={{ state: "error", reconnectAttempts: 3, lastErrorAt: "2026-03-22T12:00:07.000Z" }}
            onRefresh={onRefresh}
          />,
        );
      });
      const text = JSON.stringify(renderer.toJSON());
      expect(text).toContain("Live updates interrupted");
      expect(text).toContain("Refresh");
      const button = renderer.root.findByType("button");
      await act(async () => {
        button.props.onClick();
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("uses Cowork-specific event stream copy", async () => {
    let renderer: ReactTestRenderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <SurfaceReconnectBanner
            mode="cowork"
            status={{ state: "retrying", reconnectAttempts: 1, lastErrorAt: "2026-03-22T11:59:58.000Z" }}
            onRefresh={() => undefined}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Run events reconnecting");

      await act(async () => {
        renderer.update(
          <SurfaceReconnectBanner
            mode="cowork"
            status={{ state: "error", reconnectAttempts: 2, lastErrorAt: "2026-03-22T12:00:07.000Z" }}
            onRefresh={() => undefined}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Live run events interrupted");
    } finally {
      renderer.unmount();
    }
  });
});
