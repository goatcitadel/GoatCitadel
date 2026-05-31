import type { CapabilityPackService } from "./capability-pack-service.js";

export const capabilityPacksRouteMethods = [
  "installLocalPack",
  "installPack",
  "listPacks",
  "previewLocalPack",
  "previewPack",
] as const;

export type CapabilityPacksRouteMethod = (typeof capabilityPacksRouteMethods)[number];
export type CapabilityPacksRoutePort = Pick<CapabilityPackService, CapabilityPacksRouteMethod>;
export type CapabilityPacksRouteService = Readonly<CapabilityPacksRoutePort>;

export function createCapabilityPacksRouteService(port: CapabilityPacksRoutePort): CapabilityPacksRouteService {
  return Object.freeze({
    installLocalPack: (input) => port.installLocalPack(input),
    installPack: (packId, input) => port.installPack(packId, input),
    listPacks: () => port.listPacks(),
    previewLocalPack: (manifest) => port.previewLocalPack(manifest),
    previewPack: (packId) => port.previewPack(packId),
  });
}
