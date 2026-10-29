import {
  NotFoundError,
  ServiceUnavailableError,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type CapabilitySkillDetail,
  type CapabilitySkillsResponse,
  type DeploymentProfile,
  type SkillListItem,
} from "@goatcitadel/contracts";
import { projectCapabilityPublicValue } from "./capability-public-projection.js";
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";
import {
  buildCapabilitySkillDetail,
  buildCapabilitySkillItems,
  countWaitingCandidates,
  hiddenSkillIds,
  pendingSkillApprovalIds,
} from "./capability-skills-projection.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";

/** One reader per place the Skills tab is built from, each through its existing owner. None writes anything. */
export interface CapabilitySkillsSources {
  /** Every skill loaded for the workspace, its approved self-authored skills included, whatever its choices. */
  listSkills(workspaceId: string): Promise<readonly SkillListItem[]>;
  /** The workspace's effective skill set: "ALL", or the ids its choices (and its Citadel's) keep. */
  resolveEffectiveSkills(workspaceId: string): Promise<EffectiveCapabilitySet>;
  /** The inspectable catalog for the workspace, with every skill in it. */
  listInspectableCatalog(workspaceId: string): Promise<readonly CapabilityCatalogEntry[]>;
  /** Every approval still waiting, of any kind and in any workspace. Skill approvals have no workspace. */
  listPendingApprovals(): Promise<readonly ApprovalRequest[]>;
  /** The install's deployment profile, read on every list. */
  deploymentProfile(): DeploymentProfile;
  /** The operator's "skip approvals" setting (`settingsApprovalSkipEnabled`). */
  readApprovalSkipSetting(): Promise<boolean>;
}

export type CapabilitySkillsSource = "skills" | "workspace" | "catalog" | "approvals" | "approval_skip";

/** Called with the real error of a failed read, so the response can carry plain wording only. */
export type CapabilitySkillsFailureReporter = (source: CapabilitySkillsSource, error: unknown) => void;

const UNREADABLE_SKILLS = "Skills can't be read right now.";
const ISSUE_MESSAGES = {
  workspace: "Workspace skill choices couldn't be read right now.",
  approvals: "Waiting approvals couldn't be read right now.",
} as const;

/**
 * The Capabilities Skills tab: the installed list and one skill's details. The skills themselves must be readable; every
 * other source is read on its own and a failed one leaves its part out with a plain issue line, as the app list does.
 */
export class CapabilitySkillsService {
  public constructor(
    private readonly sources: CapabilitySkillsSources,
    private readonly reportFailure?: CapabilitySkillsFailureReporter,
  ) {}

  public async list(workspaceId: string): Promise<CapabilitySkillsResponse> {
    const [skills, effective, catalog, approvals, operatorApprovalSkip] = await Promise.all([
      this.readSkills(workspaceId),
      this.attempt("workspace", () => this.sources.resolveEffectiveSkills(workspaceId)),
      this.attempt("catalog", () => this.sources.listInspectableCatalog(workspaceId)),
      this.attempt("approvals", () => this.sources.listPendingApprovals()),
      this.readOperatorApprovalSkip(),
    ]);

    // Fixed order, whatever order the reads finish in.
    const issues = [
      ...(effective.ok ? [] : [ISSUE_MESSAGES.workspace]),
      ...(approvals.ok ? [] : [ISSUE_MESSAGES.approvals]),
    ];
    return {
      workspaceId,
      items: buildCapabilitySkillItems({
        skills,
        hiddenSkillIds: hiddenSkillIds(
          skills.map((skill) => skill.skillId),
          effective.ok ? effective.value : undefined,
        ),
        pendingApprovalIds: approvals.ok ? pendingSkillApprovalIds(approvals.value) : new Map(),
      }),
      ...(catalog.ok ? { candidatesWaiting: countWaitingCandidates(catalog.value) } : {}),
      operatorApprovalSkip,
      issues,
      generatedAt: new Date().toISOString(),
    };
  }

  /** One skill the workspace loaded, hidden or not. An id the workspace doesn't load is not found. */
  public async detail(workspaceId: string, skillId: string): Promise<CapabilitySkillDetail> {
    const [skills, catalog] = await Promise.all([
      this.readSkills(workspaceId),
      this.attempt("catalog", () => this.sources.listInspectableCatalog(workspaceId)),
    ]);
    const skill = skills.find((item) => item.skillId === skillId);
    if (!skill) throw new NotFoundError({ entity: "Skill", id: skillId });
    const entry = catalog.ok
      ? catalog.value.find((item) => item.kind === "skill" && item.capabilityId === `skill:${skillId}`)
      : undefined;
    const detail = buildCapabilitySkillDetail(skill, entry);
    // The catalog route's public projection for the parts that name a source, whose URL can carry a credential. The
    // skill's own text is sent as written, as the skills route sends it: redaction would rewrite its examples.
    return {
      ...detail,
      ...(detail.provenance ? { provenance: projectCapabilityPublicValue(detail.provenance) } : {}),
      ...(detail.catalogEntry ? { catalogEntry: projectCapabilityPublicValue(detail.catalogEntry) } : {}),
    };
  }

  /** Without the skills there is no list to show, so a failure is a plain 503 rather than an empty list. */
  private async readSkills(workspaceId: string): Promise<readonly SkillListItem[]> {
    try {
      return await this.sources.listSkills(workspaceId);
    } catch (error) {
      this.reportFailure?.("skills", error);
      throw new ServiceUnavailableError(UNREADABLE_SKILLS);
    }
  }

  /** `remote_hardened` always asks, and its setting is never read (Ruling R3). An unreadable setting asks too. */
  private async readOperatorApprovalSkip(): Promise<boolean> {
    const deploymentProfile = this.sources.deploymentProfile();
    if (deploymentProfile === "remote_hardened") return false;
    const setting = await this.attempt("approval_skip", () => this.sources.readApprovalSkipSetting());
    return setting.ok && allowsOperatorApprovalSkip(deploymentProfile, setting.value);
  }

  private async attempt<T>(
    source: CapabilitySkillsSource,
    load: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await load() };
    } catch (error) {
      this.reportFailure?.(source, error);
      return { ok: false };
    }
  }
}
