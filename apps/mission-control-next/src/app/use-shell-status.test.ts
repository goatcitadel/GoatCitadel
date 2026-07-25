import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchDashboardState: vi.fn(),
  fetchHealthSummary: vi.fn(),
  fetchRuntimeBuildIdentity: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchDashboardState: apiMocks.fetchDashboardState,
  fetchHealthSummary: apiMocks.fetchHealthSummary,
}));

vi.mock("@goatcitadel/mission-control-shared/api/review-readiness", () => ({
  fetchRuntimeBuildIdentity: apiMocks.fetchRuntimeBuildIdentity,
}));

import { useShellStatus, type UseShellStatusOptions, type UseShellStatusResult } from "./use-shell-status";

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

function Harness(props: UseShellStatusOptions & { onResult?: (result: UseShellStatusResult) => void }) {
  const result = useShellStatus(props);
  props.onResult?.(result);
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useShellStatus visibility-aware polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.fetchDashboardState.mockResolvedValue({} as never);
    apiMocks.fetchHealthSummary.mockResolvedValue({} as never);
    apiMocks.fetchRuntimeBuildIdentity.mockResolvedValue({} as never);
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
    expect(apiMocks.fetchRuntimeBuildIdentity).not.toHaveBeenCalled();

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
    expect(apiMocks.fetchRuntimeBuildIdentity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchRuntimeBuildIdentity).toHaveBeenCalledTimes(2);

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
    expect(apiMocks.fetchRuntimeBuildIdentity).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.unmount();
    });
  });

  it("drops an older build-identity response after a newer refresh finishes", async () => {
    installEnvironment(true);
    const older = createDeferred<Record<string, unknown>>();
    const newer = createDeferred<Record<string, unknown>>();
    const olderIdentity = { kind: "source", version: "1.0.0", shortSha: "1111111" };
    const newerIdentity = { kind: "packaged", version: "1.0.1", shortSha: "2222222" };
    apiMocks.fetchRuntimeBuildIdentity
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    let latest!: UseShellStatusResult;
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(
        createElement(Harness, {
          gatewayReady: true,
          refreshIntervalMs: REFRESH_INTERVAL_MS,
          onResult: (result) => {
            latest = result;
          },
        }),
      );
    });

    await act(async () => {
      void latest.refreshStatus();
      void latest.refreshStatus();
      newer.resolve(newerIdentity);
      await newer.promise;
    });
    expect(latest.status.runtimeIdentity).toEqual(newerIdentity);

    await act(async () => {
      older.resolve(olderIdentity);
      await older.promise;
    });
    expect(latest.status.runtimeIdentity).toEqual(newerIdentity);
    expect(latest.status.runtimeIdentityError).toBeNull();

    act(() => {
      renderer!.unmount();
    });
  });

  it("marks a retained build identity unavailable when its refresh fails", async () => {
    installEnvironment(true);
    const identity = { kind: "packaged", version: "1.0.0", shortSha: "abcdef0" };
    apiMocks.fetchRuntimeBuildIdentity
      .mockResolvedValueOnce(identity)
      .mockRejectedValueOnce(new Error("identity endpoint failed"));
    let latest!: UseShellStatusResult;
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(
        createElement(Harness, {
          gatewayReady: true,
          refreshIntervalMs: REFRESH_INTERVAL_MS,
          onResult: (result) => {
            latest = result;
          },
        }),
      );
    });

    await act(async () => {
      await latest.refreshStatus();
      await Promise.resolve();
    });
    expect(latest.status.runtimeIdentity).toEqual(identity);
    expect(latest.status.runtimeIdentityError).toBeNull();

    await act(async () => {
      await latest.refreshStatus();
      await Promise.resolve();
    });
    expect(latest.status.runtimeIdentity).toEqual(identity);
    expect(latest.status.runtimeIdentityError).toBe("identity endpoint failed");

    act(() => {
      renderer!.unmount();
    });
  });

  it("clears identity state and ignores an in-flight response when the gateway disconnects", async () => {
    installEnvironment(true);
    const pending = createDeferred<Record<string, unknown>>();
    apiMocks.fetchRuntimeBuildIdentity.mockImplementationOnce(() => pending.promise);
    let latest!: UseShellStatusResult;
    let renderer: ReactTestRenderer | null = null;
    act(() => {
      renderer = create(
        createElement(Harness, {
          gatewayReady: true,
          refreshIntervalMs: REFRESH_INTERVAL_MS,
          onResult: (result) => {
            latest = result;
          },
        }),
      );
    });

    await act(async () => {
      await latest.refreshStatus();
    });
    act(() => {
      renderer!.update(
        createElement(Harness, {
          gatewayReady: false,
          refreshIntervalMs: REFRESH_INTERVAL_MS,
          onResult: (result) => {
            latest = result;
          },
        }),
      );
    });
    expect(latest.status.runtimeIdentity).toBeNull();
    expect(latest.status.runtimeIdentityError).toBeNull();

    await act(async () => {
      pending.resolve({ kind: "packaged", version: "1.0.0", shortSha: "abcdef0" });
      await pending.promise;
    });
    expect(latest.status.runtimeIdentity).toBeNull();

    act(() => {
      renderer!.unmount();
    });
  });
});
