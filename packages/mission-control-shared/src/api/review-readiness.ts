import type { ReviewFindingImportResult, ReviewFindingInput, ReviewReadinessSummary } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchReviewReadiness(): Promise<ReviewReadinessSummary> {
  return request<ReviewReadinessSummary>("/api/v1/review/readiness");
}

export async function importReviewFindings(findings: ReviewFindingInput[]): Promise<ReviewFindingImportResult> {
  return request<ReviewFindingImportResult>("/api/v1/review/findings/import", {
    method: "POST",
    body: JSON.stringify({ findings }),
  });
}
