import type {
  CapabilityResourceType,
  CapabilityScopeUpdateInput,
  CapabilityScopeView,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchCitadelCapabilities(
  citadelId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`,
  );
}

export async function updateCitadelCapabilities(
  citadelId: string,
  input: CapabilityScopeUpdateInput,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(`/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function resetCitadelCapabilities(
  citadelId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`,
    { method: "DELETE" },
  );
}

export async function fetchWorkspaceCapabilities(
  workspaceId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?type=${type}`,
  );
}

export async function updateWorkspaceCapabilities(
  workspaceId: string,
  input: CapabilityScopeUpdateInput,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function resetWorkspaceCapabilities(
  workspaceId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?type=${type}`,
    { method: "DELETE" },
  );
}
