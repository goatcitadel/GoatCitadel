import type { CapabilityResourceType, CapabilityScopeAssignment, CapabilityScopeKind } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";

export const CAPABILITY_SCOPING_DISABLED_ENV = "GOATCITADEL_CAPABILITY_SCOPING_DISABLED";

/** "ALL" = no filtering (every registry resource of this type is allowed). */
export type EffectiveCapabilitySet = "ALL" | ReadonlySet<string>;

export interface ResolvedCapabilities {
  skills: EffectiveCapabilitySet;
  integrations: EffectiveCapabilitySet;
  mcpServers: EffectiveCapabilitySet;
}

export const ALL_CAPABILITIES: ResolvedCapabilities = {
  skills: "ALL",
  integrations: "ALL",
  mcpServers: "ALL",
};

export const NO_CAPABILITIES: ResolvedCapabilities = {
  skills: new Set<string>(),
  integrations: new Set<string>(),
  mcpServers: new Set<string>(),
};

/** Pure resolution algebra. Exported for table-driven tests.
 *  No rows for a scope = inherit the parent; rows present = allow-list of enabled refs.
 *  Returns "ALL" only when BOTH scopes inherit. Workspace is intersected with the
 *  citadel-effective set (a workspace can never exceed its citadel). */
export function computeEffectiveSet(
  allGlobal: ReadonlySet<string>,
  citadelRows: readonly CapabilityScopeAssignment[],
  workspaceRows: readonly CapabilityScopeAssignment[],
): EffectiveCapabilitySet {
  const citadelInherits = citadelRows.length === 0;
  const workspaceInherits = workspaceRows.length === 0;
  if (citadelInherits && workspaceInherits) {
    return "ALL";
  }
  const citadelEffective = citadelInherits
    ? new Set(allGlobal)
    : new Set(
        citadelRows
          .filter((r) => r.enabled)
          .map((r) => r.resourceRef)
          .filter((ref) => allGlobal.has(ref)),
      );
  const workspaceResolved = workspaceInherits
    ? citadelEffective
    : new Set(workspaceRows.filter((r) => r.enabled).map((r) => r.resourceRef));
  const result = new Set<string>();
  for (const ref of workspaceResolved) {
    if (citadelEffective.has(ref)) {
      result.add(ref);
    }
  }
  return result;
}

export function isCapabilityAllowed(set: EffectiveCapabilitySet, ref: string): boolean {
  return set === "ALL" || set.has(ref);
}

export interface CapabilityScopeResolverDeps {
  listAssignmentsForScope: (scopeKind: CapabilityScopeKind, scopeId: string) => readonly CapabilityScopeAssignment[];
  listAllSkillIds: () => readonly string[];
  listAllIntegrationIds: () => readonly string[];
  listAllMcpServerIds: () => readonly string[];
  /** Defaults to reading the kill-switch env var. */
  isDisabled?: () => boolean;
  onError?: (error: unknown) => void;
}

export class CapabilityScopeResolver {
  public constructor(private readonly deps: CapabilityScopeResolverDeps) {}

  public resolve(citadelId: string, workspaceId: string): ResolvedCapabilities {
    try {
      const disabled = this.deps.isDisabled ? this.deps.isDisabled() : readKillSwitch();
      if (disabled) {
        return ALL_CAPABILITIES;
      }
      const citadel = this.deps.listAssignmentsForScope("citadel", citadelId || DEFAULT_CITADEL_ID);
      const workspace = this.deps.listAssignmentsForScope("workspace", workspaceId);
      return {
        skills: this.forType("skill", this.deps.listAllSkillIds(), citadel, workspace),
        integrations: this.forType("integration", this.deps.listAllIntegrationIds(), citadel, workspace),
        mcpServers: this.forType("mcp_server", this.deps.listAllMcpServerIds(), citadel, workspace),
      };
    } catch (error) {
      this.deps.onError?.(error);
      return NO_CAPABILITIES;
    }
  }

  private forType(
    type: CapabilityResourceType,
    allGlobalIds: readonly string[],
    citadel: readonly CapabilityScopeAssignment[],
    workspace: readonly CapabilityScopeAssignment[],
  ): EffectiveCapabilitySet {
    return computeEffectiveSet(
      new Set(allGlobalIds),
      citadel.filter((r) => r.resourceType === type),
      workspace.filter((r) => r.resourceType === type),
    );
  }
}

function readKillSwitch(): boolean {
  const value = process.env[CAPABILITY_SCOPING_DISABLED_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1";
}
