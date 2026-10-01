import type {
  CapabilityResourceType,
  CapabilityScopeUpdateInput,
  CapabilityScopeView,
  CapabilityScopeKind,
  CapabilityScopeReviewedUpdateInput,
  CapabilityScopeSelectionReceipt,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

/** Reviewed commands use distinct owner paths; an older Gateway cannot silently overwrite. */
export async function updateReviewedCapabilities(
  scopeKind: CapabilityScopeKind,
  scopeId: string,
  input: CapabilityScopeReviewedUpdateInput,
): Promise<CapabilityScopeSelectionReceipt> {
  const prefix = scopeKind === "citadel" ? "citadels" : "workspaces";
  return request<CapabilityScopeSelectionReceipt>(
    `/api/v1/${prefix}/${encodeURIComponent(scopeId)}/capabilities/reviewed`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function resetReviewedCapabilities(
  scopeKind: CapabilityScopeKind,
  scopeId: string,
  resourceType: CapabilityResourceType,
  expectedRevision: string,
): Promise<CapabilityScopeSelectionReceipt> {
  const prefix = scopeKind === "citadel" ? "citadels" : "workspaces";
  return request<CapabilityScopeSelectionReceipt>(
    `/api/v1/${prefix}/${encodeURIComponent(scopeId)}/capabilities/reviewed`,
    {
      method: "DELETE",
      body: JSON.stringify({ resourceType, expectedRevision }),
    },
  );
}

export async function fetchCitadelCapabilities(
  citadelId: string,
  type: CapabilityResourceType,
): Promise<CapabilityScopeView> {
  return request<CapabilityScopeView>(`/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`);
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
  return request<CapabilityScopeView>(`/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`, {
    method: "DELETE",
  });
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
