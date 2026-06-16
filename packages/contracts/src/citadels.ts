// Citadel domain types and scope helpers.
//
// A Citadel is a protected AI operating space. Identity decision (see
// docs/citadel_update/reuse-audit.md): a Citadel IS a Workspace — `citadelId`
// is an alias for `workspaceId` — enriched with a Charter and one or more
// Chambers (sub-scopes). A workspace becomes a Citadel once it has a Charter.
//
// These helpers are the reusable enforcement primitives. They currently live in
// @goatcitadel/contracts; they can be extracted into a dedicated `citadel-core`
// package later without changing their contracts.

export type CitadelKind =
  | "personal"
  | "company"
  | "project"
  | "household"
  | "client"
  | "creator"
  | "learning"
  | "team"
  | "custom";

export type ChamberSensitivity =
  | "public"
  | "internal"
  | "private"
  | "sensitive"
  | "restricted"
  | "secret";

export type CitadelRiskPosture = "conservative" | "balanced" | "collaborative" | "automation_forward";

export type CitadelModelPolicy = "local_only" | "hybrid_guarded" | "approved_cloud" | "hosted_team";

export interface CitadelCharter {
  /** 1:1 with its Citadel (= workspace). Its presence is what makes a workspace a Citadel. */
  citadelId: string;
  purpose: string;
  kind: CitadelKind;
  goals: string[];
  boundaries: string[];
  successDefinition: string[];
  defaultChamberId?: string;
  riskPosture: CitadelRiskPosture;
  modelPolicyDefault: CitadelModelPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CitadelChamber {
  chamberId: string;
  citadelId: string;
  name: string;
  sensitivity: ChamberSensitivity;
  sealed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Citadel {
  /** Equal to the underlying workspaceId. */
  citadelId: string;
  charter: CitadelCharter;
  chambers: CitadelChamber[];
}

export interface CitadelCharterInput {
  citadelId: string;
  purpose: string;
  kind: CitadelKind;
  goals?: string[];
  boundaries?: string[];
  successDefinition?: string[];
  defaultChamberId?: string;
  riskPosture?: CitadelRiskPosture;
  modelPolicyDefault?: CitadelModelPolicy;
}

export interface CitadelChamberInput {
  citadelId: string;
  name: string;
  sensitivity?: ChamberSensitivity;
  sealed?: boolean;
}

// --- Scope: the (citadelId, chamberId?) tuple that scopes every Citadel-bound action ---

export interface CitadelScope {
  citadelId: string;
  chamberId?: string;
}

/**
 * A request-like object that may carry Citadel scope. `citadelId` is treated as
 * an alias for `workspaceId` (a Citadel IS a workspace), so either field resolves
 * the scope.
 */
export interface CitadelScopeSource {
  citadelId?: string;
  workspaceId?: string;
  chamberId?: string;
}

/**
 * Resolve the Citadel scope from a request-like object. Returns `undefined` when
 * no citadel/workspace identity is present (an unscoped / global request).
 */
export function resolveCitadelScope(source: CitadelScopeSource | null | undefined): CitadelScope | undefined {
  if (!source) {
    return undefined;
  }
  const citadelId = trimmedOrUndefined(source.citadelId) ?? trimmedOrUndefined(source.workspaceId);
  if (!citadelId) {
    return undefined;
  }
  const chamberId = trimmedOrUndefined(source.chamberId);
  return chamberId ? { citadelId, chamberId } : { citadelId };
}

/**
 * Isolation predicate: is an item living in `itemScope` visible to a viewer
 * operating in `viewerScope`?
 *
 * - Unscoped viewer (global operator surface) => sees everything.
 * - Different Citadel => never visible (hard boundary).
 * - Unscoped item => not visible to a Citadel-scoped viewer.
 * - Chamber-scoped viewer => only that Chamber, plus Citadel-general items
 *   (items with no chamber). Citadel-scoped viewer => all Chambers of the Citadel.
 */
export function isWithinCitadelScope(
  itemScope: CitadelScope | undefined,
  viewerScope: CitadelScope | undefined,
): boolean {
  if (!viewerScope) {
    return true;
  }
  if (!itemScope) {
    return false;
  }
  if (itemScope.citadelId !== viewerScope.citadelId) {
    return false;
  }
  if (viewerScope.chamberId) {
    return !itemScope.chamberId || itemScope.chamberId === viewerScope.chamberId;
  }
  return true;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
