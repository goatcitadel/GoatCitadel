import type {
  ReviewFindingImportResult,
  ReviewFindingInput,
  ReviewReadinessSummary,
  RuntimeBuildIdentity,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchReviewReadiness(): Promise<ReviewReadinessSummary> {
  return request<ReviewReadinessSummary>("/api/v1/review/readiness");
}

export async function refreshRuntimeReleaseTrust(): Promise<ReviewReadinessSummary> {
  return request<ReviewReadinessSummary>("/api/v1/review/readiness/runtime-release/refresh", {
    method: "POST",
  });
}

export async function fetchRuntimeBuildIdentity(): Promise<RuntimeBuildIdentity> {
  return request<RuntimeBuildIdentity>("/api/v1/review/identity");
}

export async function importReviewFindings(findings: ReviewFindingInput[]): Promise<ReviewFindingImportResult> {
  return request<ReviewFindingImportResult>("/api/v1/review/findings/import", {
    method: "POST",
    body: JSON.stringify({ findings }),
  });
}
