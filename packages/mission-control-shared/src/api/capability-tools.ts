import type { CapabilityToolsResponse, CapabilityToolUsageResponse } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

/**
 * Tool groups for the Capabilities page. The Gateway builds every group, risk and block reason; the cockpit only
 * renders it. The route reads `workspaceId` and nothing else, so no other parameter is sent.
 */
export async function fetchCapabilityTools(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityToolsResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<CapabilityToolsResponse>(`/api/v1/capabilities/tools?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A year of tool call counts per tool and group. The Gateway keeps the counts for ten minutes; `refresh` asks it to
 * count again, and is sent only when asked.
 */
export async function fetchCapabilityToolUsage(
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<CapabilityToolUsageResponse> {
  const query = options.refresh ? `?${new URLSearchParams({ refresh: "true" })}` : "";
  return request<CapabilityToolUsageResponse>(`/api/v1/capabilities/tools/usage${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
