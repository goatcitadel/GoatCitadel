import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  __resetFormDirtyRegistryForTests,
  describeDirtySections,
  getDirtySectionKeys,
  hasDirtySections,
  useAnySectionDirty,
  useBeforeUnloadGuard,
  useDraftTransitionGuard,
  useFormDirty,
  useNavigateGuard,
} from "./use-form-dirty";

// react-test-renderer doesn't render `host` elements as DOM, but it does run
// effects — which is what we need to exercise registry plumbing.
function Probe({ children }: { children: ReactNode }) {
  return createElement("div", null, children);
}

function FormDirtyDriver({ sectionKey, dirty, label }: { sectionKey: string; dirty: boolean; label?: string }) {
  useFormDirty(sectionKey, dirty, label !== undefined ? { label } : undefined);
  return null;
}

function ObservedDirtyKeys({ onSnapshot }: { onSnapshot: (keys: readonly string[]) => void }) {
  const keys = useAnySectionDirty();
  onSnapshot(keys);
  return null;
}

function BeforeUnloadDriver() {
  useBeforeUnloadGuard();
  return null;
}

afterEach(() => {
  __resetFormDirtyRegistryForTests();
});

describe("use-form-dirty registry", () => {
  it("registers dirty sections and surfaces them via accessors and hook", async () => {
    const snapshots: Array<readonly string[]> = [];
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, { key: "a", sectionKey: "settings:foo", dirty: false }),
          createElement(ObservedDirtyKeys, {
            key: "obs",
            onSnapshot: (keys) => snapshots.push(keys),
          }),
        ]),
      );
    });
    expect(getDirtySectionKeys()).toEqual([]);
    expect(hasDirtySections()).toBe(false);

    // Mark dirty.
    await act(async () => {
      renderer!.update(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, { key: "a", sectionKey: "settings:foo", dirty: true, label: "Foo" }),
          createElement(ObservedDirtyKeys, {
            key: "obs",
            onSnapshot: (keys) => snapshots.push(keys),
          }),
        ]),
      );
    });
    expect(getDirtySectionKeys()).toEqual(["settings:foo"]);
    expect(hasDirtySections()).toBe(true);
    expect(describeDirtySections()).toBe("Foo");
    expect(snapshots.at(-1)).toEqual(["settings:foo"]);

    // Unmount clears registry.
    await act(async () => {
      renderer!.unmount();
    });
    expect(getDirtySectionKeys()).toEqual([]);
    expect(hasDirtySections()).toBe(false);
  });

  it("describes multiple dirty sections with friendly punctuation", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, { key: "a", sectionKey: "settings:a", dirty: true, label: "Personalities" }),
          createElement(FormDirtyDriver, { key: "b", sectionKey: "settings:b", dirty: true, label: "Providers" }),
        ]),
      );
    });
    expect(describeDirtySections()).toBe("Personalities and Providers");

    await act(async () => {
      renderer!.update(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, { key: "a", sectionKey: "settings:a", dirty: true, label: "Personalities" }),
          createElement(FormDirtyDriver, { key: "b", sectionKey: "settings:b", dirty: true, label: "Providers" }),
          createElement(FormDirtyDriver, { key: "c", sectionKey: "settings:c", dirty: true, label: "Permissions" }),
        ]),
      );
    });
    // Sorted by key: settings:a, settings:b, settings:c → Personalities, Providers, Permissions
    expect(describeDirtySections()).toBe("Personalities, Providers, and Permissions");
  });

  it("ignores dirty=false sections in the snapshot but keeps labels for future flips", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(createElement(FormDirtyDriver, { sectionKey: "settings:x", dirty: false, label: "Foo" }));
    });
    expect(getDirtySectionKeys()).toEqual([]);

    await act(async () => {
      renderer!.update(createElement(FormDirtyDriver, { sectionKey: "settings:x", dirty: true, label: "Foo" }));
    });
    expect(describeDirtySections()).toBe("Foo");
  });
});

describe("useBeforeUnloadGuard", () => {
  let originalWindow: typeof globalThis.window;
  let addEventListener: ReturnType<typeof vi.fn>;
  let removeEventListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { addEventListener, removeEventListener },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("registers a beforeunload listener while mounted and removes it on unmount", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(createElement(BeforeUnloadDriver));
    });
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]![0]).toBe("beforeunload");

    await act(async () => {
      renderer!.unmount();
    });
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls[0]![0]).toBe("beforeunload");
  });

  it("prevents unload when any section is dirty", async () => {
    await act(async () => {
      create(
        createElement(Probe, null, [
          createElement(BeforeUnloadDriver, { key: "guard" }),
          createElement(FormDirtyDriver, { key: "a", sectionKey: "settings:dirty", dirty: true, label: "X" }),
        ]),
      );
    });
    const handler = addEventListener.mock.calls[0]![1] as (event: BeforeUnloadEvent) => unknown;
    const event = {
      preventDefault: vi.fn(),
      returnValue: "",
    };
    const result = handler(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toContain("unsaved");
    expect(typeof result).toBe("string");
  });

  it("does nothing when no section is dirty", async () => {
    await act(async () => {
      create(createElement(BeforeUnloadDriver));
    });
    const handler = addEventListener.mock.calls[0]![1] as (event: BeforeUnloadEvent) => unknown;
    const event = {
      preventDefault: vi.fn(),
      returnValue: "",
    };
    const result = handler(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe("useNavigateGuard", () => {
  type FakeRoute = { area: string; section: string };

  function NavigateGuardDriver({
    rawNavigate,
    currentRoute,
    onState,
    next,
  }: {
    rawNavigate: (route: FakeRoute, options?: { replace?: boolean }) => void;
    currentRoute: FakeRoute;
    onState: (state: ReturnType<typeof useNavigateGuard<FakeRoute>>) => void;
    next?: { route: FakeRoute; trigger: "navigate" | "confirm" | "cancel" };
  }) {
    const guard = useNavigateGuard<FakeRoute>(
      rawNavigate,
      (target) => target.area === currentRoute.area && target.section === currentRoute.section,
    );
    onState(guard);
    if (next) {
      if (next.trigger === "navigate") {
        guard.navigate(next.route);
      } else if (next.trigger === "confirm") {
        guard.confirmDiscard();
      } else {
        guard.cancelDiscard();
      }
    }
    return null;
  }

  it("forwards immediately when no section is dirty", async () => {
    const rawNavigate = vi.fn();
    let latest: ReturnType<typeof useNavigateGuard<FakeRoute>> | null = null;
    let _renderer: ReactTestRenderer | null = null;
    await act(async () => {
      _renderer = create(
        createElement(NavigateGuardDriver, {
          rawNavigate,
          currentRoute: { area: "settings", section: "personalities" },
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    await act(async () => {
      latest!.navigate({ area: "settings", section: "providers" });
    });
    expect(rawNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers" });
    expect(rawNavigate).toHaveBeenCalledTimes(1);
    // Single-argument invocation — no trailing `undefined` for spies.
    expect(rawNavigate.mock.calls[0]).toHaveLength(1);
    expect(latest!.pending).toBeNull();
  });

  it("defers when dirty and resolves on confirmDiscard", async () => {
    const rawNavigate = vi.fn();
    let latest: ReturnType<typeof useNavigateGuard<FakeRoute>> | null = null;
    let _renderer: ReactTestRenderer | null = null;
    await act(async () => {
      _renderer = create(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, {
            key: "a",
            sectionKey: "settings:foo",
            dirty: true,
            label: "Foo",
          }),
          createElement(NavigateGuardDriver, {
            key: "guard",
            rawNavigate,
            currentRoute: { area: "settings", section: "personalities" },
            onState: (state) => {
              latest = state;
            },
          }),
        ]),
      );
    });

    // Attempt nav while dirty → deferred.
    await act(async () => {
      latest!.navigate({ area: "settings", section: "providers" });
    });
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(latest!.pending).toEqual({ route: { area: "settings", section: "providers" } });

    // Confirm discards dirty + forwards nav.
    await act(async () => {
      latest!.confirmDiscard();
    });
    expect(rawNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers" });
    expect(rawNavigate.mock.calls[0]).toHaveLength(1);
    expect(hasDirtySections()).toBe(false);
    expect(latest!.pending).toBeNull();
  });

  it("cancelDiscard leaves dirty state untouched", async () => {
    const rawNavigate = vi.fn();
    let latest: ReturnType<typeof useNavigateGuard<FakeRoute>> | null = null;
    let _renderer: ReactTestRenderer | null = null;
    await act(async () => {
      _renderer = create(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, {
            key: "a",
            sectionKey: "settings:foo",
            dirty: true,
            label: "Foo",
          }),
          createElement(NavigateGuardDriver, {
            key: "guard",
            rawNavigate,
            currentRoute: { area: "settings", section: "personalities" },
            onState: (state) => {
              latest = state;
            },
          }),
        ]),
      );
    });

    await act(async () => {
      latest!.navigate({ area: "settings", section: "providers" });
    });
    await act(async () => {
      latest!.cancelDiscard();
    });
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(hasDirtySections()).toBe(true);
    expect(latest!.pending).toBeNull();
  });

  it("skips the dirty check when navigating to the current route", async () => {
    const rawNavigate = vi.fn();
    let latest: ReturnType<typeof useNavigateGuard<FakeRoute>> | null = null;
    await act(async () => {
      create(
        createElement(Probe, null, [
          createElement(FormDirtyDriver, {
            key: "a",
            sectionKey: "settings:foo",
            dirty: true,
            label: "Foo",
          }),
          createElement(NavigateGuardDriver, {
            key: "guard",
            rawNavigate,
            currentRoute: { area: "settings", section: "personalities" },
            onState: (state) => {
              latest = state;
            },
          }),
        ]),
      );
    });
    await act(async () => {
      latest!.navigate({ area: "settings", section: "personalities" });
    });
    expect(rawNavigate).toHaveBeenCalledWith({ area: "settings", section: "personalities" });
    expect(latest!.pending).toBeNull();
  });

  it("forwards options when caller passes them", async () => {
    const rawNavigate = vi.fn();
    let latest: ReturnType<typeof useNavigateGuard<FakeRoute>> | null = null;
    await act(async () => {
      create(
        createElement(NavigateGuardDriver, {
          rawNavigate,
          currentRoute: { area: "settings", section: "personalities" },
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    await act(async () => {
      latest!.navigate({ area: "settings", section: "providers" }, { replace: true });
    });
    expect(rawNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers" }, { replace: true });
  });
});

describe("useDraftTransitionGuard", () => {
  function DraftTransitionDriver({
    dirty,
    applyTransition,
    resetDraft,
    onState,
  }: {
    dirty: boolean;
    applyTransition: (value: string) => void;
    resetDraft: () => void;
    onState: (state: ReturnType<typeof useDraftTransitionGuard<string>>) => void;
  }) {
    const guard = useDraftTransitionGuard(dirty, applyTransition, resetDraft);
    onState(guard);
    return null;
  }

  it("keeps clean transitions silent", async () => {
    const applyTransition = vi.fn();
    const resetDraft = vi.fn();
    let latest: ReturnType<typeof useDraftTransitionGuard<string>> | null = null;
    await act(async () => {
      create(
        createElement(DraftTransitionDriver, {
          dirty: false,
          applyTransition,
          resetDraft,
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });

    await act(async () => {
      latest!.requestTransition("next");
    });

    expect(applyTransition).toHaveBeenCalledWith("next");
    expect(resetDraft).not.toHaveBeenCalled();
    expect(latest!.pendingTransition).toBeNull();
  });

  it("defers dirty transitions, preserves edits on cancel, and resets before confirm", async () => {
    const callOrder: string[] = [];
    const applyTransition = vi.fn((value: string) => callOrder.push(`apply:${value}`));
    const resetDraft = vi.fn(() => callOrder.push("reset"));
    let latest: ReturnType<typeof useDraftTransitionGuard<string>> | null = null;
    await act(async () => {
      create(
        createElement(DraftTransitionDriver, {
          dirty: true,
          applyTransition,
          resetDraft,
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });

    await act(async () => {
      latest!.requestTransition("cancelled");
    });
    expect(latest!.pendingTransition).toBe("cancelled");
    await act(async () => {
      latest!.cancelDiscard();
    });
    expect(applyTransition).not.toHaveBeenCalled();
    expect(resetDraft).not.toHaveBeenCalled();
    expect(latest!.pendingTransition).toBeNull();

    await act(async () => {
      latest!.requestTransition("confirmed");
    });
    await act(async () => {
      latest!.confirmDiscard();
    });
    expect(callOrder).toEqual(["reset", "apply:confirmed"]);
    expect(latest!.pendingTransition).toBeNull();
  });
});
