// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { connectEventStream } from "@goatcitadel/mission-control-shared/api/shell-client";
import { deriveRealtimeRefresh } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { useShellNotifications } from "./use-shell-notifications";
import { REALTIME_COMPATIBILITY_DECAY_MS, REALTIME_REPLAY_GAP_DECAY_MS, useEventStream } from "./use-event-stream";

/*
 * MCNEXT-002: the realtime SSE subscription must NOT tear down/reconnect when
 * the operator merely toggles a notification preference. It SHOULD reconnect
 * for a real connection-affecting change (gateway readiness). The fix keeps
 * `deliverRealtimeNotification` referentially stable (preferences behind a
 * ref), so the subscription effect (dep on that callback + gatewayReady) does
 * not re-run on preference changes — while delivery still uses the latest
 * preferences via the ref.
 */

// connectEventStream is the lifecycle boundary: we count subscribe calls and
// expose a close spy + the captured onEvent so we can fire a realtime event.
const closeSpy = vi.fn();
let capturedOnEvent: ((event: unknown) => void) | null = null;

vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({
  connectEventStream: vi.fn((onEvent: (event: unknown) => void) => {
    capturedOnEvent = onEvent;
    return closeSpy;
  }),
}));

// Keep the store/derive side-effects inert so the test isolates lifecycle.
vi.mock("@goatcitadel/mission-control-shared/state/event-stream-status-store", () => ({
  publishEventStreamStatus: vi.fn(),
  resetEventStreamStatus: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/channel-activity-store", () => ({
  publishChannelActivityFromRealtimeEvent: vi.fn(),
  resetChannelActivitySnapshots: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/refresh-bus", () => ({
  emitRefresh: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/realtime-derived", () => ({
  deriveRealtimeRefresh: vi.fn(() => ({
    topics: [],
    truthMode: "authoritative",
    signalReason: "test",
    signalEventType: "test",
  })),
  deriveRealtimeNotification: vi.fn(() => ({
    tone: "info" as const,
    message: "Realtime event",
    groupKey: "g",
    soundCue: "ping" as const,
  })),
}));

const mockedConnect = vi.mocked(connectEventStream);

const BASE_PREFS: UiNotificationPreferences = {
  toastsEnabled: true,
  soundMode: "off",
  desktopEnabled: false,
  onlyWhenUnfocused: false,
};

// Mirrors MissionControlNextApp's composition: notifications hook produces the
// delivery callback that feeds the event-stream hook.
function ShellHarness({
  preferences,
  gatewayReady,
  onToastCount,
}: {
  preferences: UiNotificationPreferences;
  gatewayReady: boolean;
  onToastCount: (count: number) => void;
}) {
  const { notifications, deliverRealtimeNotification } = useShellNotifications({
    notificationPreferences: preferences,
  });
  useEventStream({ gatewayReady, onRealtimeNotification: deliverRealtimeNotification });
  onToastCount(notifications.length);
  return null;
}

describe("event stream notification-preference stability (MCNEXT-002)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockedConnect.mockClear();
    closeSpy.mockClear();
    capturedOnEvent = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("does not reconnect the stream when only a notification preference changes", async () => {
    let toastCount = 0;
    await act(async () => {
      root.render(
        <ShellHarness preferences={BASE_PREFS} gatewayReady onToastCount={(count) => (toastCount = count)} />,
      );
    });

    expect(mockedConnect).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();

    // Toggle preferences with a NEW object identity (what the topbar volume
    // button / settings toggles do). The stream must stay connected.
    await act(async () => {
      root.render(
        <ShellHarness
          preferences={{ ...BASE_PREFS, soundMode: "normal", toastsEnabled: false }}
          gatewayReady
          onToastCount={(count) => (toastCount = count)}
        />,
      );
    });

    expect(mockedConnect).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
    void toastCount;
  });

  it("still tears down and reconnects when gateway readiness changes", async () => {
    await act(async () => {
      root.render(<ShellHarness preferences={BASE_PREFS} gatewayReady onToastCount={() => {}} />);
    });
    expect(mockedConnect).toHaveBeenCalledTimes(1);

    // Gateway drops: effect cleanup runs (close) and the not-ready branch holds.
    await act(async () => {
      root.render(<ShellHarness preferences={BASE_PREFS} gatewayReady={false} onToastCount={() => {}} />);
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Gateway returns: a fresh subscription is established.
    await act(async () => {
      root.render(<ShellHarness preferences={BASE_PREFS} gatewayReady onToastCount={() => {}} />);
    });
    expect(mockedConnect).toHaveBeenCalledTimes(2);
  });

  it("delivers using the latest preferences after a toggle (notifications keep working)", async () => {
    let toastCount = 0;
    // Start with toasts OFF.
    await act(async () => {
      root.render(
        <ShellHarness
          preferences={{ ...BASE_PREFS, toastsEnabled: false }}
          gatewayReady
          onToastCount={(count) => (toastCount = count)}
        />,
      );
    });

    // Fire an event while toasts are off → no toast pushed.
    await act(async () => {
      capturedOnEvent?.({ eventId: "e1", source: "surface" });
      await Promise.resolve();
    });
    expect(toastCount).toBe(0);

    // Toggle toasts ON (new object). Stream stays connected (same onEvent).
    await act(async () => {
      root.render(
        <ShellHarness
          preferences={{ ...BASE_PREFS, toastsEnabled: true }}
          gatewayReady
          onToastCount={(count) => (toastCount = count)}
        />,
      );
    });
    expect(mockedConnect).toHaveBeenCalledTimes(1);

    // Fire another event → toast IS pushed because the ref now sees toastsEnabled.
    await act(async () => {
      capturedOnEvent?.({ eventId: "e2", source: "surface" });
      await Promise.resolve();
    });
    expect(toastCount).toBe(1);
  });
});

/*
 * Task 1.3 (QA finding N1): "compatibility" truth-mode is transient per-event
 * topic-inference nuance, not a transport downgrade — it must decay back to
 * "authoritative" after REALTIME_COMPATIBILITY_DECAY_MS (15s) without a newer
 * non-authoritative event. "replay-gap" decays after REALTIME_REPLAY_GAP_DECAY_MS
 * (30s). This suite drives the mocked deriveRealtimeRefresh return value per
 * captured event and asserts on the hook's exposed streamTruthMode using fake
 * timers, mirroring the harness pattern above.
 */

const mockedDeriveRealtimeRefresh = vi.mocked(deriveRealtimeRefresh);

function TruthModeHarness({
  gatewayReady,
  onTruthMode,
}: {
  gatewayReady: boolean;
  onTruthMode: (mode: string) => void;
}) {
  const { deliverRealtimeNotification } = useShellNotifications({ notificationPreferences: BASE_PREFS });
  const { streamTruthMode } = useEventStream({ gatewayReady, onRealtimeNotification: deliverRealtimeNotification });
  onTruthMode(streamTruthMode);
  return null;
}

describe("realtime truth-mode decay (N1)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedConnect.mockClear();
    closeSpy.mockClear();
    capturedOnEvent = null;
    mockedDeriveRealtimeRefresh.mockReturnValue({
      topics: [],
      truthMode: "authoritative",
      usedCompatibilityInference: false,
      signalReason: "test",
      signalEventType: "test",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  function deliverEvent(truthMode: "authoritative" | "compatibility" | "replay-gap") {
    mockedDeriveRealtimeRefresh.mockReturnValueOnce({
      topics: [],
      truthMode,
      usedCompatibilityInference: truthMode === "compatibility",
      signalReason: "test",
      signalEventType: "test",
    });
    capturedOnEvent?.({ eventId: `e-${Date.now()}-${Math.random()}`, source: "surface" });
  }

  it("decays a keyword-only compatibility event back to authoritative after 15s", async () => {
    let truthMode = "authoritative";
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });
    expect(truthMode).toBe("authoritative");

    await act(async () => {
      deliverEvent("compatibility");
      await Promise.resolve();
    });
    expect(truthMode).toBe("compatibility");

    // Not yet decayed just before the deadline.
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_COMPATIBILITY_DECAY_MS - 1);
    });
    expect(truthMode).toBe("compatibility");

    // Decays at the deadline, with NO further stream events / state changes.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(truthMode).toBe("authoritative");
    // Decay must not touch stream connectivity — no reconnect, no close.
    expect(mockedConnect).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("measures decay from the most recent compatibility event, not the first", async () => {
    let truthMode = "authoritative";
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });

    await act(async () => {
      deliverEvent("compatibility");
    });
    expect(truthMode).toBe("compatibility");

    // 10s later, a second compatibility event arrives — this should reschedule
    // the decay timer measured from THIS event, not the first.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      deliverEvent("compatibility");
    });
    expect(truthMode).toBe("compatibility");

    // 14s after the SECOND event (24s after the first): still compatibility,
    // because decay is measured from the second event's schedule.
    await act(async () => {
      vi.advanceTimersByTime(14_000);
    });
    expect(truthMode).toBe("compatibility");

    // +1s more (15s after the second event): now it decays.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(truthMode).toBe("authoritative");
  });

  it("decays replay-gap at 30s, not 15s", async () => {
    let truthMode = "authoritative";
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });

    await act(async () => {
      deliverEvent("replay-gap");
    });
    expect(truthMode).toBe("replay-gap");

    // At the compatibility deadline (15s), replay-gap must NOT have decayed yet.
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_COMPATIBILITY_DECAY_MS);
    });
    expect(truthMode).toBe("replay-gap");

    // Remaining time to reach the replay-gap deadline (30s total).
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_REPLAY_GAP_DECAY_MS - REALTIME_COMPATIBILITY_DECAY_MS - 1);
    });
    expect(truthMode).toBe("replay-gap");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(truthMode).toBe("authoritative");
  });

  it("clears the decay timer on unmount without a post-unmount setState/act warning", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let truthMode = "authoritative";
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });

    await act(async () => {
      deliverEvent("compatibility");
    });
    expect(truthMode).toBe("compatibility");

    await act(async () => {
      root.unmount();
    });

    // Advancing timers past the decay deadline after unmount must not throw or
    // attempt a setState on the unmounted tree.
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_COMPATIBILITY_DECAY_MS + 1_000);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("clears the decay timer when the gateway (stream) is torn down and reconnected", async () => {
    let truthMode = "authoritative";
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });

    await act(async () => {
      deliverEvent("compatibility");
    });
    expect(truthMode).toBe("compatibility");

    // Gateway drops mid-decay: stream tears down, and the existing "closed"
    // reset takes effect. The pending decay timer must be cleared so it
    // cannot fire later and clobber a fresh stream's state.
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady={false} onTruthMode={(mode) => (truthMode = mode)} />);
    });
    expect(truthMode).toBe("authoritative");

    // Reconnect: a fresh subscription starts clean at authoritative, and
    // advancing time past the old (now-cleared) deadline must not regress it.
    await act(async () => {
      root.render(<TruthModeHarness gatewayReady onTruthMode={(mode) => (truthMode = mode)} />);
    });
    expect(truthMode).toBe("authoritative");

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_COMPATIBILITY_DECAY_MS + 1_000);
    });
    expect(truthMode).toBe("authoritative");
  });
});
