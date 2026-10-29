import type { CapabilityResourceType, CapabilityScopeAssignment, CapabilityScopeKind } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";

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
  listAssignmentsForScope: (
    scopeKind: CapabilityScopeKind,
    scopeId: string,
  ) => Promise<readonly CapabilityScopeAssignment[]> | readonly CapabilityScopeAssignment[];
  listAllSkillIds: () => Promise<readonly string[]> | readonly string[];
  listAllIntegrationIds: () => Promise<readonly string[]> | readonly string[];
  listAllMcpServerIds: () => Promise<readonly string[]> | readonly string[];
  /** Defaults to reading the kill-switch env var. */
  isDisabled?: () => boolean;
  onError?: (error: unknown) => void;
}

export class CapabilityScopeResolver {
  public constructor(private readonly deps: CapabilityScopeResolverDeps) {}

  public async resolve(citadelId: string, workspaceId: string): Promise<ResolvedCapabilities> {
    return await this.resolveWith(
      citadelId,
      workspaceId,
      { disabled: ALL_CAPABILITIES, fault: NO_CAPABILITIES },
      () =>
        Promise.all([this.deps.listAllSkillIds(), this.deps.listAllIntegrationIds(), this.deps.listAllMcpServerIds()]),
      ([skillIds, integrationIds, mcpServerIds], citadel, workspace) => ({
        skills: this.forType("skill", skillIds, citadel, workspace),
        integrations: this.forType("integration", integrationIds, citadel, workspace),
        mcpServers: this.forType("mcp_server", mcpServerIds, citadel, workspace),
      }),
    );
  }

  /** Skills only, for the reads every turn makes: a fault reading integrations or MCP servers never hides a
   *  skill, while a fault reading the skill choices themselves still leaves no skill chosen. */
  public async resolveSkills(citadelId: string, workspaceId: string): Promise<EffectiveCapabilitySet> {
    return await this.resolveWith(
      citadelId,
      workspaceId,
      { disabled: ALL_CAPABILITIES.skills, fault: NO_CAPABILITIES.skills },
      async () => await this.deps.listAllSkillIds(),
      (skillIds, citadel, workspace) => this.forType("skill", skillIds, citadel, workspace),
    );
  }

  /** Reads both scopes' assignments with the registry ids. The kill switch yields `disabled`; any fault yields
   *  `fault` (fail closed). */
  private async resolveWith<Ids, Result>(
    citadelId: string,
    workspaceId: string,
    outcomes: { disabled: Result; fault: Result },
    listIds: () => Promise<Ids>,
    project: (
      ids: Ids,
      citadel: readonly CapabilityScopeAssignment[],
      workspace: readonly CapabilityScopeAssignment[],
    ) => Result,
  ): Promise<Result> {
    try {
      if ((this.deps.isDisabled ?? readKillSwitch)()) {
        return outcomes.disabled;
      }
      const [citadel, workspace, ids] = await Promise.all([
        this.deps.listAssignmentsForScope("citadel", citadelId || DEFAULT_CITADEL_ID),
        this.deps.listAssignmentsForScope("workspace", workspaceId),
        listIds(),
      ]);
      return project(ids, citadel, workspace);
    } catch (error) {
      this.deps.onError?.(error);
      return outcomes.fault;
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

/** The bounded, redacted evidence a scope read fault leaves: the error's name only, since its message can carry
 *  storage detail. The read itself still fails closed. */
export function reportCapabilityScopeFault(
  record: (input: {
    level: "warn";
    category: "gateway";
    event: string;
    message: string;
    context: { errorName: string };
  }) => void,
): (error: unknown) => void {
  return (error) => {
    const errorName = error instanceof Error ? error.name : typeof error;
    const message = "Capability scope choices could not be read, so none count as chosen.";
    logger.warn(message, { errorName });
    record({
      level: "warn",
      category: "gateway",
      event: "capability_scope.read_failed",
      message,
      context: { errorName },
    });
  };
}

function readKillSwitch(): boolean {
  const value = process.env[CAPABILITY_SCOPING_DISABLED_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1";
}
