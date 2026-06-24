import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchDashboardState: vi.fn(),
  fetchHealthSummary: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchDashboardState: apiMocks.fetchDashboardState,
  fetchHealthSummary: apiMocks.fetchHealthSummary,
}));

import { useShellStatus, type UseShellStatusOptions } from "./use-shell-status";

const REFRESH_INTERVAL_MS = 15_000;

type VisibilityDocument = {
  hidden: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  dispatchVisibilityChange: () => void;
};

function installEnvironment(hidden: boolean): VisibilityDocument {
  const listeners = new Map<string, Set<() => void>>();
  const doc: VisibilityDocument = {
    hidden,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchVisibilityChange: () => {
      for (const listener of listeners.get("visibilitychange") ?? []) {
        listener();
      }
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: doc,
  });
  return doc;
}

function Harness(props: UseShellStatusOptions) {
  useShellStatus(props);
  return null;
}

describe("useShellStatus visibility-aware polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.fetchDashboardState.mockResolvedValue({} as never);
    apiMocks.fetchHealthSummary.mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  });

  it("does not poll while the tab is hidden", async () => {
    installEnvironment(true);
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(createElement(Harness, { gatewayReady: true, refreshIntervalMs: REFRESH_INTERVAL_MS }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    });

    expect(apiMocks.fetchDashboardState).not.toHaveBeenCalled();
    expect(apiMocks.fetchHealthSummary).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });

  it("polls on each interval tick while the tab is visible", async () => {
    installEnvironment(false);
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(createElement(Harness, { gatewayReady: true, refreshIntervalMs: REFRESH_INTERVAL_MS }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(2);

    act(() => {
      renderer!.unmount();
    });
  });

  it("runs one immediate refresh when the tab becomes visible again", async () => {
    const doc = installEnvironment(true);
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(createElement(Harness, { gatewayReady: true, refreshIntervalMs: REFRESH_INTERVAL_MS }));
    });

    // Hidden: a full interval elapses with no fetches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(apiMocks.fetchDashboardState).not.toHaveBeenCalled();

    // Tab returns to foreground -> one immediate catch-up refresh.
    doc.hidden = false;
    await act(async () => {
      doc.dispatchVisibilityChange();
      await Promise.resolve();
    });
    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.unmount();
    });
  });
});
