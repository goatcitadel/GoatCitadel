import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { UiPreferencesProvider, useUiPreferences } from "./ui-preferences";

const originalWindow = (globalThis as typeof globalThis & { window?: Window }).window;

function installWindowWithStorage(initialEntries: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initialEntries));
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage } as Window & typeof globalThis,
  });
}

describe("UiPreferencesProvider", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
  });

  it("defaults new users to compact nav mode", () => {
    installWindowWithStorage();

    let observedNavMode = "";

    function Probe() {
      observedNavMode = useUiPreferences().navMode;
      return null;
    }

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UiPreferencesProvider>
          <Probe />
        </UiPreferencesProvider>,
      );
    });

    expect(observedNavMode).toBe("compact");
    act(() => {
      renderer!.unmount();
    });
  });

  it("preserves stored nav mode preferences", () => {
    installWindowWithStorage({ "goatcitadel.ui.nav_mode.v1": "expanded" });

    let observedNavMode = "";

    function Probe() {
      observedNavMode = useUiPreferences().navMode;
      return null;
    }

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UiPreferencesProvider>
          <Probe />
        </UiPreferencesProvider>,
      );
    });

    expect(observedNavMode).toBe("expanded");
    act(() => {
      renderer!.unmount();
    });
  });

  it("persists status center expansion preferences", () => {
    installWindowWithStorage();

    let observedExpanded = false;

    function Probe() {
      const { statusCenterExpanded, setStatusCenterExpanded } = useUiPreferences();
      observedExpanded = statusCenterExpanded;

      React.useEffect(() => {
        setStatusCenterExpanded(true);
      }, [setStatusCenterExpanded]);

      return null;
    }

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UiPreferencesProvider>
          <Probe />
        </UiPreferencesProvider>,
      );
    });

    expect(observedExpanded).toBe(true);
    expect(window.localStorage.getItem("goatcitadel.ui.status_center_expanded.v1")).toBe("true");

    act(() => {
      renderer!.unmount();
    });
  });
});
