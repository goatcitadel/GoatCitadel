import {
  EvidenceReceiptService,
  type EvidenceReceipt,
  type EvidenceReceiptServiceDeps,
  type EvidenceReceiptVerification,
} from "./evidence-receipt-service.js";

export const evidenceReceiptsRouteMethods = ["buildEvidenceReceipt", "verifyEvidenceReceipt"] as const;

export type EvidenceReceiptsRouteMethod = (typeof evidenceReceiptsRouteMethods)[number];

export interface EvidenceReceiptsRoutePort {
  buildEvidenceReceipt(runId: string): Promise<EvidenceReceipt>;
  verifyEvidenceReceipt(receipt: unknown): EvidenceReceiptVerification;
}

export type EvidenceReceiptsRouteService = Readonly<EvidenceReceiptsRoutePort>;

export function createEvidenceReceiptsRouteService(deps: EvidenceReceiptServiceDeps): EvidenceReceiptsRouteService {
  const service = new EvidenceReceiptService(deps);
  return Object.freeze({
    buildEvidenceReceipt: (runId: string) => service.buildEvidenceReceipt(runId),
    verifyEvidenceReceipt: (receipt: unknown) => service.verifyEvidenceReceipt(receipt),
  });
}
