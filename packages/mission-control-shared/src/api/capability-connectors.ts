import type { CapabilityConnectorsResponse } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

/** Connector list for the Capabilities page. The Gateway builds every row; the cockpit only renders it. */
export async function fetchCapabilityConnectors(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilityConnectorsResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<CapabilityConnectorsResponse>(`/api/v1/capabilities/connectors?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
