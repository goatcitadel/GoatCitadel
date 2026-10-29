import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import type { CapabilityCatalogEntry, CapabilityCatalogScope, SkillListItem } from "@goatcitadel/contracts";
import type { CapabilityScopeResolver, EffectiveCapabilitySet } from "./capability-scope-resolver.js";
import type { CapabilitySystemService } from "./capability-system-service.js";

/** Where a workspace's skill choices come from: its own selection and its Citadel's. */
export interface WorkspaceSkillChoiceSources {
  resolver: Pick<CapabilityScopeResolver, "resolveSkills">;
  /** The workspace's Citadel, read the same way the capability scope routes and the MCP scope gate read it. */
  resolveCitadelId(workspaceId: string): Promise<string>;
  /** Reports a fault reading the workspace's Citadel (`reportCapabilityScopeFault`). */
  onError?: (error: unknown) => void;
}

/**
 * A workspace's effective skill choices: its own selection narrowed by its Citadel's, or "ALL" when neither has
 * chosen. Both reads fail closed: a fault reading the Citadel or the choices leaves no installed skill chosen.
 */
export async function resolveWorkspaceSkillChoices(
  sources: WorkspaceSkillChoiceSources,
  workspaceId: string,
): Promise<EffectiveCapabilitySet> {
  let citadelId: string;
  try {
    citadelId = await sources.resolveCitadelId(workspaceId);
  } catch (error) {
    sources.onError?.(error);
    return new Set<string>();
  }
  return await sources.resolver.resolveSkills(citadelId || DEFAULT_CITADEL_ID, workspaceId);
}

export type TurnSkillCatalogSource = Pick<CapabilitySystemService, "listSkills" | "listCatalog">;

/**
 * The skills a workspace's turns may load or call. Chat turns, scheduled turns, feature and mesh admission, skill
 * discovery and remote workers all read through here, so a skill the workspace's choices leave out is neither
 * loaded nor callable there. Its own approved self-authored skills always count as chosen, because no selection can
 * name them (`CapabilitySystemService.listSkills`). Lifecycle, each skill's own switch, deny-wins policy and
 * approvals still apply on top. Without a workspace the reads stay install-wide, as before. Operator views (the
 * skill and catalog routes, the Skills tab, Library) read `CapabilitySystemService` directly.
 */
export class WorkspaceTurnSkills {
  public constructor(
    private readonly catalog: TurnSkillCatalogSource,
    private readonly choices: WorkspaceSkillChoiceSources,
  ) {}

  public async listSkills(workspaceId?: string): Promise<SkillListItem[]> {
    if (workspaceId === undefined) return await this.catalog.listSkills();
    return await this.catalog.listSkills(await resolveWorkspaceSkillChoices(this.choices, workspaceId), workspaceId);
  }

  public async listCatalog(scope: CapabilityCatalogScope, workspaceId?: string): Promise<CapabilityCatalogEntry[]> {
    if (workspaceId === undefined) return await this.catalog.listCatalog(scope);
    const chosen = await resolveWorkspaceSkillChoices(this.choices, workspaceId);
    return await this.catalog.listCatalog(scope, chosen, workspaceId);
  }

  /** The base prompt's skill index: the install's skills the workspace has chosen, without its self-authored ones,
   *  which that index has never listed. */
  public async listInstalledCatalog(
    scope: CapabilityCatalogScope,
    workspaceId?: string,
  ): Promise<CapabilityCatalogEntry[]> {
    if (workspaceId === undefined) return await this.catalog.listCatalog(scope);
    return await this.catalog.listCatalog(scope, await resolveWorkspaceSkillChoices(this.choices, workspaceId));
  }
}
