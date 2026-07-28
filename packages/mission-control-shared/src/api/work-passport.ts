import type { WorkPassportBaselineResponse, WorkPassportBaselineUpdateInput } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export function fetchWorkPassportBaseline(workspaceId: string): Promise<WorkPassportBaselineResponse> {
  const params = new URLSearchParams({ workspaceId });
  return request(`/api/v1/work-passport/baseline?${params.toString()}`);
}

export function updateWorkPassportBaseline(
  input: WorkPassportBaselineUpdateInput,
): Promise<WorkPassportBaselineResponse> {
  return request("/api/v1/work-passport/baseline", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
