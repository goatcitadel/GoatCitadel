import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";

export const evidenceRouteMethods = ["listEnvelopes"] as const;

export type EvidenceRouteMethod = (typeof evidenceRouteMethods)[number];
export type EvidenceRoutePort = Pick<EvidenceEnvelopeService, EvidenceRouteMethod>;
export type EvidenceRouteService = Readonly<EvidenceRoutePort>;

export function createEvidenceRouteService(port: EvidenceRoutePort): EvidenceRouteService {
  return Object.freeze({
    listEnvelopes: (input) => port.listEnvelopes(input),
  });
}
