import type {
  OpsQualityExportFormat,
  OpsQualityOtelExportResponse,
  OpsQualitySnapshotResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchOpsQualitySnapshot(
  input: { packLimit?: number; evalLimit?: number } = {},
): Promise<OpsQualitySnapshotResponse> {
  const search = new URLSearchParams();
  if (input.packLimit !== undefined) {
    search.set("packLimit", String(Math.max(1, Math.min(input.packLimit, 2000))));
  }
  if (input.evalLimit !== undefined) {
    search.set("evalLimit", String(Math.max(1, Math.min(input.evalLimit, 200))));
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  return request<OpsQualitySnapshotResponse>(`/api/v1/ops/quality${query}`);
}

export async function exportOpsQualityEvidence(
  input: { packLimit?: number; evalLimit?: number; format?: OpsQualityExportFormat } = {},
): Promise<OpsQualityOtelExportResponse> {
  const search = new URLSearchParams();
  search.set("format", input.format ?? "otel_json");
  if (input.packLimit !== undefined) {
    search.set("packLimit", String(Math.max(1, Math.min(input.packLimit, 2000))));
  }
  if (input.evalLimit !== undefined) {
    search.set("evalLimit", String(Math.max(1, Math.min(input.evalLimit, 200))));
  }
  return request<OpsQualityOtelExportResponse>(`/api/v1/ops/quality/export?${search.toString()}`);
}
