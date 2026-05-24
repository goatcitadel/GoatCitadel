import { describe, expect, it, vi } from "vitest";
import { createAddonsRoutePort, createAddonsRouteService } from "./addons-route-service.js";

describe("addons route service", () => {
  it("delegates catalog/status operations and freezes the route facade", () => {
    const deps = fakeDeps();
    const port = createAddonsRoutePort(deps);
    const service = createAddonsRouteService(port);

    expect(service.getAddonStatus("addon-1")).toEqual({ status: "installed" });
    expect(service.listAddonsCatalog()).toEqual([{ addonId: "addon-1" }]);
    expect(service.listInstalledAddons()).toEqual([{ addonId: "addon-1", status: "installed" }]);
    expect(Object.isFrozen(service)).toBe(true);
    expect(deps.addonsService.getStatus).toHaveBeenCalledWith("addon-1");
    expect(deps.addonsService.listCatalog).toHaveBeenCalledWith();
    expect(deps.addonsService.listInstalled).toHaveBeenCalledWith();
  });

  it("records install and launch diagnostics and emits addon runtime events", async () => {
    const deps = fakeDeps();
    const service = createAddonsRouteService(createAddonsRoutePort(deps));

    await expect(service.installAddon("addon-1", { actorId: "operator" })).resolves.toEqual(result("installed"));
    await expect(service.launchAddon("addon-1")).resolves.toEqual(result("running"));

    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "addon.install.start", context: { actorId: "operator" } }),
    );
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "addon.install.complete", context: { status: "installed" } }),
    );
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "addon.launch.complete",
        context: { status: "running", launchUrl: "https://installed.example.test" },
      }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_installed", "system", {
      addonId: "addon-1",
      status: "installed",
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_runtime_changed", "system", {
      addonId: "addon-1",
      status: "running",
    });
  });

  it("delegates listAddonSlots to the slot service for route filtering and global listing", () => {
    const deps = fakeDeps();
    const service = createAddonsRouteService(createAddonsRoutePort(deps));

    const routed = service.listAddonSlots("/ops/approvals");
    expect(deps.slotService.findSlotsForRoute).toHaveBeenCalledWith("/ops/approvals", undefined);
    expect(routed).toEqual([{ addonId: "addon-1", slot: "ops.approvals.actions", route: "/ops/approvals" }]);

    const all = service.listAddonSlots();
    expect(deps.slotService.listAllRegistrations).toHaveBeenCalled();
    expect(all).toHaveLength(2);
  });

  it("filters slot registrations to a specific slot kind when only slot is provided", () => {
    const deps = fakeDeps();
    const service = createAddonsRouteService(createAddonsRoutePort(deps));

    const filtered = service.listAddonSlots(undefined, "library.skills.cards");
    expect(deps.slotService.listAllRegistrations).toHaveBeenCalled();
    expect(filtered).toEqual([{ addonId: "addon-2", slot: "library.skills.cards" }]);
  });

  it("falls back to catalog launch URL and emits lifecycle, stop, uninstall, and update events", async () => {
    const deps = fakeDeps();
    deps.addonsService.launch.mockResolvedValueOnce({
      status: { status: "running", addon: { launchUrl: "https://catalog.example.test" } },
    });
    const service = createAddonsRouteService(createAddonsRoutePort(deps));

    await service.launchAddon("addon-2");
    await expect(service.enableAddon("addon-2")).resolves.toEqual(result("installed"));
    await expect(service.disableAddon("addon-2")).resolves.toEqual(result("disabled"));
    await expect(service.stopAddon("addon-2")).resolves.toEqual(result("stopped"));
    await expect(service.uninstallAddon("addon-2")).resolves.toEqual(result("uninstalled"));
    await expect(service.updateAddon("addon-2")).resolves.toEqual(result("updated"));

    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "addon.launch.complete",
        context: { status: "running", launchUrl: "https://catalog.example.test" },
      }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_runtime_changed", "system", {
      addonId: "addon-2",
      status: "stopped",
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_enabled", "system", {
      addonId: "addon-2",
      status: "installed",
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_disabled", "system", {
      addonId: "addon-2",
      status: "disabled",
    });
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_uninstalled", "system", { addonId: "addon-2" });
    expect(deps.publishRealtime).toHaveBeenCalledWith("addon_updated", "system", {
      addonId: "addon-2",
      status: "updated",
    });
  });
});

function result(status: string) {
  return {
    status: {
      status,
      addon: { launchUrl: "https://catalog.example.test" },
      installed: { launchUrl: "https://installed.example.test" },
    },
  };
}

function fakeDeps() {
  return {
    addonsService: {
      getStatus: vi.fn(() => ({ status: "installed" })),
      disable: vi.fn(async () => result("disabled")),
      enable: vi.fn(async () => result("installed")),
      install: vi.fn(async () => result("installed")),
      launch: vi.fn(async () => result("running")),
      listCatalog: vi.fn(() => [{ addonId: "addon-1" }]),
      listInstalled: vi.fn(() => [{ addonId: "addon-1", status: "installed" }]),
      stop: vi.fn(async () => result("stopped")),
      uninstall: vi.fn(async () => result("uninstalled")),
      update: vi.fn(async () => result("updated")),
    } as never,
    slotService: {
      findSlotsForRoute: vi.fn(() => [{ addonId: "addon-1", slot: "ops.approvals.actions", route: "/ops/approvals" }]),
      listAllRegistrations: vi.fn(() => [
        { addonId: "addon-1", slot: "ops.approvals.actions" },
        { addonId: "addon-2", slot: "library.skills.cards" },
      ]),
      registerDeclarations: vi.fn(),
      unregister: vi.fn(),
    } as never,
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
  };
}
