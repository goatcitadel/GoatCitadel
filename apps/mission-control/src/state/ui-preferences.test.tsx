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

  it("uses safe defaults when browser storage is unavailable", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    let observed: ReturnType<typeof useUiPreferences> | undefined;

    function Probe() {
      observed = useUiPreferences();
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

    expect(observed).toMatchObject({
      activeWorkspaceId: "default",
      density: "default",
      detailPanelPinned: false,
      effectsMode: "auto",
      mode: "simple",
      navMode: "compact",
      showTechnicalDetails: false,
      statusCenterExpanded: false,
      theme: "dark",
    });

    act(() => {
      observed!.setTheme("light");
    });

    expect(observed!.theme).toBe("light");

    act(() => {
      renderer!.unmount();
    });
  });

  it("exposes inert defaults when used without a provider", () => {
    let observed: ReturnType<typeof useUiPreferences> | undefined;

    function Probe() {
      const preferences = useUiPreferences();
      const updated = React.useRef(false);
      observed = preferences;

      React.useEffect(() => {
        if (updated.current) {
          return;
        }
        updated.current = true;
        preferences.setMode("advanced");
        preferences.setDensity("compact");
        preferences.setEffectsMode("full");
        preferences.setNavMode("expanded");
        preferences.setShowTechnicalDetails(true);
        preferences.setDetailPanelPinned(true);
        preferences.setStatusCenterExpanded(true);
        preferences.setActiveWorkspaceId("workspace-1");
        preferences.setTheme("light");
      }, [preferences]);

      return null;
    }

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });

    expect(observed).toMatchObject({
      activeWorkspaceId: "default",
      density: "default",
      detailPanelPinned: false,
      effectsMode: "auto",
      mode: "simple",
      navMode: "compact",
      showTechnicalDetails: false,
      statusCenterExpanded: false,
      theme: "dark",
    });

    act(() => {
      renderer!.unmount();
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

  it("honors explicitly stored technical detail preferences", () => {
    installWindowWithStorage({
      "goatcitadel.ui.mode.v1": "advanced",
      "goatcitadel.ui.technical_details.v1": "false",
    });

    let observedDetails = true;

    function Probe() {
      observedDetails = useUiPreferences().showTechnicalDetails;
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

    expect(observedDetails).toBe(false);

    act(() => {
      renderer!.unmount();
    });

    installWindowWithStorage({
      "goatcitadel.ui.mode.v1": "simple",
      "goatcitadel.ui.technical_details.v1": "true",
    });

    act(() => {
      renderer = create(
        <UiPreferencesProvider>
          <Probe />
        </UiPreferencesProvider>,
      );
    });

    expect(observedDetails).toBe(true);

    act(() => {
      renderer!.unmount();
    });
  });

  it("hydrates valid stored preferences and derives details from advanced mode when unset", () => {
    installWindowWithStorage({
      "goatcitadel.ui.mode.v1": "advanced",
      "goatcitadel.ui.density.v1": "compact",
      "goatcitadel.ui.effects_mode.v1": "full",
      "goatcitadel.ui.nav_mode.v1": "icon",
      "goatcitadel.ui.detail_panel_pinned.v1": "true",
      "goatcitadel.ui.status_center_expanded.v1": "true",
      "goatcitadel.ui.workspace_id.v1": "workspace.alpha-1",
      "goatcitadel.ui.theme.v1": "light",
    });

    let observed: ReturnType<typeof useUiPreferences> | undefined;

    function Probe() {
      observed = useUiPreferences();
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

    expect(observed).toMatchObject({
      activeWorkspaceId: "workspace.alpha-1",
      density: "compact",
      detailPanelPinned: true,
      effectsMode: "full",
      mode: "advanced",
      navMode: "icon",
      showTechnicalDetails: true,
      statusCenterExpanded: true,
      theme: "light",
    });

    act(() => {
      renderer!.unmount();
    });
  });

  it("falls back when stored enum and workspace values are invalid", () => {
    installWindowWithStorage({
      "goatcitadel.ui.mode.v1": "expert",
      "goatcitadel.ui.density.v1": "dense",
      "goatcitadel.ui.effects_mode.v1": "cinematic",
      "goatcitadel.ui.nav_mode.v1": "floating",
      "goatcitadel.ui.technical_details.v1": "maybe",
      "goatcitadel.ui.detail_panel_pinned.v1": "yes",
      "goatcitadel.ui.status_center_expanded.v1": "yes",
      "goatcitadel.ui.workspace_id.v1": "../workspace",
      "goatcitadel.ui.theme.v1": "neon",
    });

    let observed: ReturnType<typeof useUiPreferences> | undefined;

    function Probe() {
      observed = useUiPreferences();
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

    expect(observed).toMatchObject({
      activeWorkspaceId: "default",
      density: "default",
      detailPanelPinned: false,
      effectsMode: "auto",
      mode: "simple",
      navMode: "compact",
      showTechnicalDetails: false,
      statusCenterExpanded: false,
      theme: "dark",
    });

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

  it("persists preference updates and normalizes workspace ids", () => {
    installWindowWithStorage();

    let observed: ReturnType<typeof useUiPreferences> | undefined;

    function Probe() {
      const preferences = useUiPreferences();
      const updated = React.useRef(false);
      observed = preferences;

      React.useEffect(() => {
        if (updated.current) {
          return;
        }
        updated.current = true;
        preferences.setMode("advanced");
        preferences.setDensity("comfortable");
        preferences.setEffectsMode("reduced");
        preferences.setNavMode("expanded");
        preferences.setShowTechnicalDetails(false);
        preferences.setDetailPanelPinned(true);
        preferences.setStatusCenterExpanded(true);
        preferences.setActiveWorkspaceId("  team.ops_1  ");
        preferences.setTheme("light");
      }, [preferences]);

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

    expect(observed).toMatchObject({
      activeWorkspaceId: "team.ops_1",
      density: "comfortable",
      detailPanelPinned: true,
      effectsMode: "reduced",
      mode: "advanced",
      navMode: "expanded",
      showTechnicalDetails: false,
      statusCenterExpanded: true,
      theme: "light",
    });
    expect(window.localStorage.getItem("goatcitadel.ui.mode.v1")).toBe("advanced");
    expect(window.localStorage.getItem("goatcitadel.ui.technical_details.v1")).toBe("false");
    expect(window.localStorage.getItem("goatcitadel.ui.workspace_id.v1")).toBe("team.ops_1");
    expect(window.localStorage.getItem("goatcitadel.ui.theme.v1")).toBe("light");

    act(() => {
      observed!.setActiveWorkspaceId(" ");
    });

    expect(observed!.activeWorkspaceId).toBe("default");
    expect(window.localStorage.getItem("goatcitadel.ui.workspace_id.v1")).toBe("default");

    act(() => {
      renderer!.unmount();
    });
  });
});
