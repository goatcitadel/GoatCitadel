// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { connectEventStream } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useShellNotifications } from "./use-shell-notifications";
import { useEventStream } from "./use-event-stream";

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
