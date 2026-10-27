import type {
  CapabilityConnectorsResponse,
  ConnectorInstallRequest,
  ConnectorInstallResponse,
} from "@goatcitadel/contracts";
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

/**
 * Installs a connector from its template through one Change Plan. The receipt says whether the plan finished or waits
 * for an approval in the Inbox; the client adds the Idempotency-Key every non-GET carries.
 */
export async function installCapabilityConnector(input: ConnectorInstallRequest): Promise<ConnectorInstallResponse> {
  return request<ConnectorInstallResponse>("/api/v1/capabilities/connectors/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
