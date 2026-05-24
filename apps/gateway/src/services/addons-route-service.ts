import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import type { AddonsService } from "./addons-service.js";
import type { AddonDashboardSlot } from "@goatcitadel/contracts";
import type { AddonSlotService } from "./addon-slot-service.js";

export const addonsRouteMethods = [
  "getAddonStatus",
  "disableAddon",
  "enableAddon",
  "installAddon",
  "launchAddon",
  "listAddonSlots",
  "listAddonsCatalog",
  "listInstalledAddons",
  "stopAddon",
  "uninstallAddon",
  "updateAddon",
] as const;

export type AddonsRouteMethod = (typeof addonsRouteMethods)[number];
export type AddonsRoutePort = RoutePort<AddonsRouteMethod>;
export type AddonsRouteService = RouteService<AddonsRouteMethod>;

export interface AddonsRoutePortDependencies {
  addonsService: AddonsService;
  slotService: AddonSlotService;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  recordDevDiagnostic: (input: Parameters<GatewayDevDiagnosticsService["record"]>[0]) => void;
}

export function createAddonsRoutePort(deps: AddonsRoutePortDependencies): AddonsRoutePort {
  return {
    getAddonStatus: (addonId) => deps.addonsService.getStatus(addonId),
    installAddon: async (addonId, input) => {
      deps.recordDevDiagnostic({
        level: "info",
        category: "addons",
        event: "addon.install.start",
        message: `Installing addon ${addonId}`,
        context: { actorId: input.actorId },
      });
      const result = await deps.addonsService.install(addonId, input);
      deps.recordDevDiagnostic({
        level: "info",
        category: "addons",
        event: "addon.install.complete",
        message: `Installed addon ${addonId}`,
        context: { status: result.status.status },
      });
      deps.publishRealtime("addon_installed", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
    disableAddon: async (addonId) => {
      const result = await deps.addonsService.disable(addonId);
      deps.publishRealtime("addon_disabled", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
    enableAddon: async (addonId) => {
      const result = await deps.addonsService.enable(addonId);
      deps.publishRealtime("addon_enabled", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
    launchAddon: async (addonId) => {
      deps.recordDevDiagnostic({
        level: "info",
        category: "addons",
        event: "addon.launch.start",
        message: `Launching addon ${addonId}`,
      });
      const result = await deps.addonsService.launch(addonId);
      deps.recordDevDiagnostic({
        level: "info",
        category: "addons",
        event: "addon.launch.complete",
        message: `Launched addon ${addonId}`,
        context: {
          status: result.status.status,
          launchUrl: result.status.installed?.launchUrl ?? result.status.addon.launchUrl,
        },
      });
      deps.publishRealtime("addon_runtime_changed", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
    listAddonSlots: (route?: string, slot?: AddonDashboardSlot) => {
      if (typeof route === "string" && route.length > 0) {
        return deps.slotService.findSlotsForRoute(route, slot);
      }
      const registrations = deps.slotService.listAllRegistrations();
      if (slot) {
        return registrations.filter((registration) => registration.slot === slot);
      }
      return registrations;
    },
    listAddonsCatalog: () => deps.addonsService.listCatalog(),
    listInstalledAddons: () => deps.addonsService.listInstalled(),
    stopAddon: async (addonId) => {
      const result = await deps.addonsService.stop(addonId);
      deps.publishRealtime("addon_runtime_changed", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
    uninstallAddon: async (addonId) => {
      const result = await deps.addonsService.uninstall(addonId);
      deps.publishRealtime("addon_uninstalled", "system", { addonId });
      return result;
    },
    updateAddon: async (addonId) => {
      const result = await deps.addonsService.update(addonId);
      deps.publishRealtime("addon_updated", "system", {
        addonId,
        status: result.status.status,
      });
      return result;
    },
  };
}

export function createAddonsRouteService(port: AddonsRoutePort): AddonsRouteService {
  return createRouteService(port, addonsRouteMethods);
}
