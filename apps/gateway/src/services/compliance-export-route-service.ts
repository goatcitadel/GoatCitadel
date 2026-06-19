import {
  ComplianceExportService,
  type BuildComplianceBundleInput,
  type ComplianceBundle,
  type ComplianceBundleVerification,
  type ComplianceExportServiceDeps,
} from "./compliance-export-service.js";

export const complianceRouteMethods = ["buildComplianceBundle", "verifyComplianceBundle"] as const;

export type ComplianceRouteMethod = (typeof complianceRouteMethods)[number];

export interface ComplianceRoutePort {
  buildComplianceBundle(input: BuildComplianceBundleInput): ComplianceBundle;
  verifyComplianceBundle(bundle: unknown): ComplianceBundleVerification;
}

export type ComplianceRouteService = Readonly<ComplianceRoutePort>;

export function createComplianceRouteService(deps: ComplianceExportServiceDeps): ComplianceRouteService {
  const service = new ComplianceExportService(deps);
  return Object.freeze({
    buildComplianceBundle: (input: BuildComplianceBundleInput) => service.buildComplianceBundle(input),
    verifyComplianceBundle: (bundle: unknown) => service.verifyComplianceBundle(bundle),
  });
}
