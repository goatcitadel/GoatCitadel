import type { CapabilityPackService } from "./capability-pack-service.js";

export const capabilityPacksRouteMethods = ["installPack", "listPacks", "previewPack"] as const;

export type CapabilityPacksRouteMethod = (typeof capabilityPacksRouteMethods)[number];
export type CapabilityPacksRoutePort = Pick<CapabilityPackService, CapabilityPacksRouteMethod>;
export type CapabilityPacksRouteService = Readonly<CapabilityPacksRoutePort>;

export function createCapabilityPacksRouteService(port: CapabilityPacksRoutePort): CapabilityPacksRouteService {
  return Object.freeze({
    installPack: (packId, input) => port.installPack(packId, input),
    listPacks: () => port.listPacks(),
    previewPack: (packId) => port.previewPack(packId),
  });
}
