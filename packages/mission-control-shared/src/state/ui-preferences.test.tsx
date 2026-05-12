import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UiPreferencesProvider, useUiPreferences } from "./ui-preferences";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length() {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

type UiPreferences = ReturnType<typeof useUiPreferences>;

function installWindow(storage = new MemoryStorage()) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      localStorage: storage,
    },
  });
  return storage;
}

function renderPreferences() {
  let latest!: UiPreferences;
  const Harness = () => {
    latest = useUiPreferences();
    return null;
  };
  const renderer = create(
    <UiPreferencesProvider>
      <Harness />
    </UiPreferencesProvider>,
  );
  return {
    renderer,
    get result() {
      return latest;
    },
  };
}

describe("ui preferences", () => {
  beforeEach(() => {
    installWindow();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("provides inert defaults outside a provider and storage-safe defaults without window", () => {
    Reflect.deleteProperty(globalThis, "window");
    let latest!: UiPreferences;
    const Harness = () => {
      latest = useUiPreferences();
      return null;
    };

    create(<Harness />);
    expect(latest).toMatchObject({
      mode: "simple",
      density: "default",
      effectsMode: "auto",
      navMode: "compact",
      showTechnicalDetails: false,
      detailPanelPinned: false,
      statusCenterExpanded: false,
      activeWorkspaceId: "default",
      theme: "dark",
    });
    act(() => {
      latest.setMode("advanced");
      latest.setDensity("compact");
      latest.setEffectsMode("full");
      latest.setNavMode("expanded");
      latest.setShowTechnicalDetails(true);
      latest.setDetailPanelPinned(true);
      latest.setStatusCenterExpanded(true);
      latest.setActiveWorkspaceId("workspace-1");
      latest.setTheme("light");
    });
  });

  it("loads valid stored preferences and normalizes invalid workspace ids", () => {
    const storage = installWindow();
    storage.setItem("goatcitadel.ui.mode.v1", "advanced");
    storage.setItem("goatcitadel.ui.density.v1", "comfortable");
    storage.setItem("goatcitadel.ui.effects_mode.v1", "reduced");
    storage.setItem("goatcitadel.ui.nav_mode.v1", "icon");
    storage.setItem("goatcitadel.ui.technical_details.v1", "false");
    storage.setItem("goatcitadel.ui.detail_panel_pinned.v1", "true");
    storage.setItem("goatcitadel.ui.status_center_expanded.v1", "true");
    storage.setItem("goatcitadel.ui.workspace_id.v1", "../bad");
    storage.setItem("goatcitadel.ui.theme.v1", "light");

    const hook = renderPreferences();

    expect(hook.result).toMatchObject({
      mode: "advanced",
      density: "comfortable",
      effectsMode: "reduced",
      navMode: "icon",
      showTechnicalDetails: false,
      detailPanelPinned: true,
      statusCenterExpanded: true,
      activeWorkspaceId: "default",
      theme: "light",
    });

    hook.renderer.unmount();
  });

  it("persists every setter and derives technical details from experience mode", () => {
    const storage = installWindow();
    const hook = renderPreferences();

    act(() => {
      hook.result.setMode("advanced");
    });
    expect(hook.result.mode).toBe("advanced");
    expect(hook.result.showTechnicalDetails).toBe(true);
    expect(storage.getItem("goatcitadel.ui.mode.v1")).toBe("advanced");
    expect(storage.getItem("goatcitadel.ui.technical_details.v1")).toBe("true");

    act(() => {
      hook.result.setDensity("compact");
      hook.result.setEffectsMode("full");
      hook.result.setNavMode("expanded");
      hook.result.setShowTechnicalDetails(false);
      hook.result.setDetailPanelPinned(true);
      hook.result.setStatusCenterExpanded(true);
      hook.result.setActiveWorkspaceId("workspace.alpha-1");
      hook.result.setTheme("light");
    });

    expect(hook.result).toMatchObject({
      density: "compact",
      effectsMode: "full",
      navMode: "expanded",
      showTechnicalDetails: false,
      detailPanelPinned: true,
      statusCenterExpanded: true,
      activeWorkspaceId: "workspace.alpha-1",
      theme: "light",
    });
    expect(storage.getItem("goatcitadel.ui.density.v1")).toBe("compact");
    expect(storage.getItem("goatcitadel.ui.effects_mode.v1")).toBe("full");
    expect(storage.getItem("goatcitadel.ui.nav_mode.v1")).toBe("expanded");
    expect(storage.getItem("goatcitadel.ui.detail_panel_pinned.v1")).toBe("true");
    expect(storage.getItem("goatcitadel.ui.status_center_expanded.v1")).toBe("true");
    expect(storage.getItem("goatcitadel.ui.workspace_id.v1")).toBe("workspace.alpha-1");
    expect(storage.getItem("goatcitadel.ui.theme.v1")).toBe("light");

    act(() => {
      hook.result.setActiveWorkspaceId(" ");
      hook.result.setMode("simple");
    });
    expect(hook.result.activeWorkspaceId).toBe("default");
    expect(hook.result.showTechnicalDetails).toBe(false);

    hook.renderer.unmount();
  });

  it("falls back for invalid stored enum values and infers details from advanced mode", () => {
    const storage = installWindow();
    storage.setItem("goatcitadel.ui.mode.v1", "advanced");
    storage.setItem("goatcitadel.ui.density.v1", "tiny");
    storage.setItem("goatcitadel.ui.effects_mode.v1", "loud");
    storage.setItem("goatcitadel.ui.nav_mode.v1", "wide");
    storage.setItem("goatcitadel.ui.theme.v1", "solarized");

    const hook = renderPreferences();

    expect(hook.result).toMatchObject({
      mode: "advanced",
      density: "default",
      effectsMode: "auto",
      navMode: "compact",
      showTechnicalDetails: true,
      theme: "dark",
    });
    hook.renderer.unmount();
  });

  it("uses provider defaults without window and accepts alternate valid stored values", () => {
    Reflect.deleteProperty(globalThis, "window");
    const serverHook = renderPreferences();
    expect(serverHook.result).toMatchObject({
      mode: "simple",
      density: "default",
      effectsMode: "auto",
      navMode: "compact",
      showTechnicalDetails: false,
      detailPanelPinned: false,
      statusCenterExpanded: false,
      activeWorkspaceId: "default",
      theme: "dark",
    });
    act(() => {
      serverHook.result.setDensity("comfortable");
      serverHook.result.setActiveWorkspaceId("server");
    });
    expect(serverHook.result.density).toBe("comfortable");
    expect(serverHook.result.activeWorkspaceId).toBe("server");
    serverHook.renderer.unmount();

    const storage = installWindow();
    storage.setItem("goatcitadel.ui.density.v1", "compact");
    storage.setItem("goatcitadel.ui.effects_mode.v1", "full");
    storage.setItem("goatcitadel.ui.nav_mode.v1", "expanded");
    storage.setItem("goatcitadel.ui.technical_details.v1", "true");
    storage.setItem("goatcitadel.ui.workspace_id.v1", "workspace_2");
    storage.setItem("goatcitadel.ui.theme.v1", "dark");

    const hook = renderPreferences();
    expect(hook.result).toMatchObject({
      density: "compact",
      effectsMode: "full",
      navMode: "expanded",
      showTechnicalDetails: true,
      activeWorkspaceId: "workspace_2",
      theme: "dark",
    });
    hook.renderer.unmount();
  });
});
