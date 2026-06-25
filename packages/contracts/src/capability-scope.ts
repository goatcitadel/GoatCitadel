export const CAPABILITY_SCOPE_KINDS = ["citadel", "workspace"] as const;
export type CapabilityScopeKind = (typeof CAPABILITY_SCOPE_KINDS)[number];

export const CAPABILITY_RESOURCE_TYPES = ["skill", "integration", "mcp_server"] as const;
export type CapabilityResourceType = (typeof CAPABILITY_RESOURCE_TYPES)[number];

export interface CapabilityScopeAssignment {
  assignmentId: string;
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  resourceRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** "inherit" = no rows for this (scope,type) → inherits the parent set.
 *  "curated" = rows exist → only enabled refs are available (may be empty). */
export type CapabilityScopeMode = "inherit" | "curated";

export interface CapabilityScopeItem {
  resourceRef: string;
  label: string;
  /** Whether this ref is in the scope's effective set. */
  enabled: boolean;
  /** Whether this ref currently exists in the parent-effective / registry set. */
  available: boolean;
  /** True when the scope has no explicit row for this type (value inherited from parent). */
  inherited: boolean;
}

export interface CapabilityScopeView {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  resourceType: CapabilityResourceType;
  mode: CapabilityScopeMode;
  items: CapabilityScopeItem[];
  effectiveRefs: string[];
}

/** PATCH body: replace the scope's curated set for one resource type. */
export interface CapabilityScopeUpdateInput {
  resourceType: CapabilityResourceType;
  /** Full candidate set with per-ref enabled flags. Empty array = curate-to-empty. */
  assignments: Array<{ resourceRef: string; enabled: boolean }>;
}

export function isCapabilityScopeKind(value: unknown): value is CapabilityScopeKind {
  return typeof value === "string" && (CAPABILITY_SCOPE_KINDS as readonly string[]).includes(value);
}

export function isCapabilityResourceType(value: unknown): value is CapabilityResourceType {
  return typeof value === "string" && (CAPABILITY_RESOURCE_TYPES as readonly string[]).includes(value);
}
