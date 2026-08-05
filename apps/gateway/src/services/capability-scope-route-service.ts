import type {
  CapabilityResourceType,
  CapabilityScopeKind,
  CapabilityScopeUpdateInput,
  CapabilityScopeView,
} from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CapabilityScopeResolver, EffectiveCapabilitySet } from "./capability-scope-resolver.js";

export interface CapabilityRegistryEntry {
  ref: string;
  label: string;
}

export interface CapabilityScopeRouteServiceDeps {
  repo: Pick<AsyncStorage["capabilityScope"], "list" | "replaceSet" | "clear">;
  resolver: CapabilityScopeResolver;
  /** Live registry entries (ref + label) per resource type. */
  listRegistry: (resourceType: CapabilityResourceType) => Promise<CapabilityRegistryEntry[]>;
  /** Resolve a workspace's citadel id (mirrors turn-prep). */
  resolveCitadelId: (workspaceId: string) => Promise<string>;
}

/** A workspace id guaranteed to have no assignment rows, so the resolver yields the
 *  pure citadel-effective set (workspace inherits citadel). */
const NO_WORKSPACE = "__capability_scope_no_workspace__";

export class CapabilityScopeRouteService {
  public constructor(private readonly deps: CapabilityScopeRouteServiceDeps) {}

  public async getView(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): Promise<CapabilityScopeView> {
    const rows = await this.deps.repo.list(scopeKind, scopeId, resourceType);
    const mode = rows.length === 0 ? "inherit" : "curated";
    const effective = await this.effectiveFor(scopeKind, scopeId, resourceType);
    const candidates = await this.candidateEntries(scopeKind, scopeId, resourceType);
    const items = candidates.map((entry) => ({
      resourceRef: entry.ref,
      label: entry.label,
      available: true,
      inherited: mode === "inherit",
      enabled: effective === "ALL" ? true : effective.has(entry.ref),
    }));
    // surface curated rows whose ref no longer exists in the registry (available:false)
    for (const row of rows) {
      if (!candidates.some((c) => c.ref === row.resourceRef)) {
        items.push({
          resourceRef: row.resourceRef,
          label: row.resourceRef,
          available: false,
          inherited: false,
          enabled: false,
        });
      }
    }
    return {
      scopeKind,
      scopeId,
      resourceType,
      mode,
      items,
      effectiveRefs: effective === "ALL" ? candidates.map((c) => c.ref) : [...effective],
    };
  }

  public async updateScope(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    input: CapabilityScopeUpdateInput,
  ): Promise<CapabilityScopeView> {
    await this.deps.repo.replaceSet(
      scopeKind,
      scopeId,
      input.resourceType,
      input.assignments.map((a) => ({ resourceRef: a.resourceRef, enabled: a.enabled })),
    );
    return await this.getView(scopeKind, scopeId, input.resourceType);
  }

  public async resetScope(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): Promise<CapabilityScopeView> {
    await this.deps.repo.clear(scopeKind, scopeId, resourceType);
    return await this.getView(scopeKind, scopeId, resourceType);
  }

  /**
   * Resolves the effective skill set for a workspace, for use in skills listing.
   * Returns "ALL" when the workspace (and its citadel) have no skill assignments
   * configured — preserving the non-breaking default behavior.
   */
  public async resolveEffectiveSkills(workspaceId: string): Promise<EffectiveCapabilitySet> {
    const citadelId = await this.deps.resolveCitadelId(workspaceId);
    return await this.resolveType(citadelId, workspaceId, "skill");
  }

  /** Candidate set: citadel scope draws from the global registry; workspace scope draws
   *  from the citadel-effective set (D4 — a workspace can only narrow its citadel). */
  private async candidateEntries(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): Promise<CapabilityRegistryEntry[]> {
    const registry = await this.deps.listRegistry(resourceType);
    if (scopeKind === "citadel") {
      return registry;
    }
    const citadelId = await this.deps.resolveCitadelId(scopeId);
    // Citadel-effective = resolve with a workspace that has no rows (inherits citadel).
    const citadelEffective = await this.resolveType(citadelId, NO_WORKSPACE, resourceType);
    return citadelEffective === "ALL" ? registry : registry.filter((e) => citadelEffective.has(e.ref));
  }

  private async effectiveFor(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): Promise<EffectiveCapabilitySet> {
    if (scopeKind === "citadel") {
      return await this.resolveType(scopeId, NO_WORKSPACE, resourceType);
    }
    const citadelId = await this.deps.resolveCitadelId(scopeId);
    return await this.resolveType(citadelId, scopeId, resourceType);
  }

  private async resolveType(
    citadelId: string,
    workspaceId: string,
    resourceType: CapabilityResourceType,
  ): Promise<EffectiveCapabilitySet> {
    const resolved = await this.deps.resolver.resolve(citadelId || DEFAULT_CITADEL_ID, workspaceId);
    return resourceType === "skill"
      ? resolved.skills
      : resourceType === "integration"
        ? resolved.integrations
        : resolved.mcpServers;
  }
}
