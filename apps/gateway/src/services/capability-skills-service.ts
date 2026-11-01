import {
  NotFoundError,
  SHIPPED_SKILL_CATEGORIES,
  ServiceUnavailableError,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type CapabilitySkillDetail,
  type CapabilitySkillInstallsResponse,
  type CapabilitySkillsResponse,
  type DeploymentProfile,
  type SkillListItem,
} from "@goatcitadel/contracts";
import {
  buildCapabilitySkillInstall,
  isUnfinishedInstall,
  SKILL_HUB_LIST_LIMIT,
} from "./capability-skill-install-projection.js";
import { projectCapabilityPublicValue } from "./capability-public-projection.js";
import {
  buildCapabilitySkillDetail,
  buildCapabilitySkillItems,
  countWaitingCandidates,
  pendingSkillApprovalIds,
  type ShippedSkillDirs,
} from "./capability-skills-projection.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";
import type { SkillHubOperatorItem } from "./skill-hub-operator-service.js";

/** One reader per place the Skills tab is built from, each through its existing owner. None writes anything. */
export interface CapabilitySkillsSources {
  /** Every skill loaded for the workspace, its approved self-authored skills included, whatever its choices. */
  listSkills(workspaceId: string): Promise<readonly SkillListItem[]>;
  /** The inspectable catalog for the workspace, with every skill in it. */
  listInspectableCatalog(workspaceId: string): Promise<readonly CapabilityCatalogEntry[]>;
  /** Every approval still waiting, of any kind and in any workspace. Skill approvals have no workspace. */
  listPendingApprovals(): Promise<readonly ApprovalRequest[]>;
  /**
   * The skills the switch can reach: the ones the skill state owner looks a skill up in before it asks for a change.
   * A workspace's self-authored skills are not among them.
   */
  listSwitchableSkillIds(): Promise<readonly string[]>;
  /**
   * The skills the workspace's turns may load: the ones its skill choices keep, plus its own approved self-authored
   * skills. This is the list Chat, scheduled turns and remote workers read, so a loaded skill missing from it is one
   * the workspace's choices leave out.
   */
  listWorkspaceTurnSkills(workspaceId: string): Promise<readonly SkillListItem[]>;
  /** Where GoatCitadel's own skills outside `skills/bundled` come from on this install, to tell them from imports. */
  shippedSkillDirs(): ShippedSkillDirs;
  /** The install's deployment profile, read on every list. */
  deploymentProfile(): DeploymentProfile;
  /** The operator's "skip approvals" setting (`settingsApprovalSkipEnabled`). */
  readApprovalSkipSetting(): Promise<boolean>;
  /** Skill Hub's operator list: the workspace's newest checks, each with its approvals, settlements and guards. */
  listSkillHub(input: { workspaceId: string; limit: number }): Promise<{ items: readonly SkillHubOperatorItem[] }>;
  /** One Skill Hub check by its id, in any workspace: what source it read. */
  findSkillHubSnapshot(snapshotId: string): Promise<{ sourceType: string; sourceRef: string } | undefined>;
  /**
   * The Skill Hub checks plugin records list as their skills, by check id, with the plugin that lists each: what marks
   * a skill switched on from one of them.
   */
  listPluginSkills(): Promise<ReadonlyMap<string, { pluginId: string; name: string }>>;
  /** The skills uninstalls removed, by skill id, with the plugin each went with: what reads one as removed with it. */
  listRemovedPluginSkills(): Promise<ReadonlyMap<string, { name: string }>>;
}

export type CapabilitySkillsSource =
  | "skills"
  | "catalog"
  | "approvals"
  | "switchable"
  | "turn_skills"
  | "approval_skip"
  | "skill_hub"
  | "skill_hub_check"
  | "plugins";

/** Called with the real error of a failed read, so the response can carry plain wording only. */
export type CapabilitySkillsFailureReporter = (source: CapabilitySkillsSource, error: unknown) => void;

const UNREADABLE_SKILLS = "Skills can't be read right now.";
const UNREADABLE_INSTALLS = "Skill installs can't be read right now.";
const ISSUE_MESSAGES = {
  approvals: "Waiting approvals couldn't be read right now.",
  switchable: "Which skills can be switched couldn't be read right now.",
  turnSkills: "Which skills this workspace's chats can use couldn't be read right now.",
  plugins: "Which skills came with a plugin couldn't be read right now.",
} as const;

/**
 * The Capabilities Skills tab: the installed list, one skill's details, and the installs still on their way in. For the
 * installed list the skills themselves must be readable; every other source is read on its own and a failed one leaves
 * its part out with a plain issue line, as the app list does.
 */
export class CapabilitySkillsService {
  public constructor(
    private readonly sources: CapabilitySkillsSources,
    private readonly reportFailure?: CapabilitySkillsFailureReporter,
  ) {}

  public async list(workspaceId: string): Promise<CapabilitySkillsResponse> {
    const [skills, catalog, approvals, switchable, turnSkills, operatorApprovalSkip, pluginSkills] = await Promise.all([
      this.readSkills(workspaceId),
      this.attempt("catalog", () => this.sources.listInspectableCatalog(workspaceId)),
      this.attempt("approvals", () => this.sources.listPendingApprovals()),
      this.attempt("switchable", () => this.sources.listSwitchableSkillIds()),
      this.attempt("turn_skills", () => this.sources.listWorkspaceTurnSkills(workspaceId)),
      this.readOperatorApprovalSkip(),
      this.attempt("plugins", async () => ({
        fromPlugin: await this.sources.listPluginSkills(),
        removed: await this.sources.listRemovedPluginSkills(),
      })),
    ]);
    const packSnapshotIds = await this.readPackSnapshotIds(skills);

    // Fixed order, whatever order the reads finish in.
    const issues = [
      ...(approvals.ok ? [] : [ISSUE_MESSAGES.approvals]),
      ...(switchable.ok ? [] : [ISSUE_MESSAGES.switchable]),
      ...(turnSkills.ok ? [] : [ISSUE_MESSAGES.turnSkills]),
      ...(pluginSkills.ok ? [] : [ISSUE_MESSAGES.plugins]),
    ];
    const candidatesWaiting = catalog.ok ? countWaitingCandidates(catalog.value) : undefined;
    return {
      workspaceId,
      items: buildCapabilitySkillItems({
        skills,
        pendingApprovalIds: approvals.ok ? pendingSkillApprovalIds(approvals.value) : new Map(),
        // A lookup that can't be read offers no switch, rather than one the owner might refuse.
        switchableSkillIds: new Set(switchable.ok ? switchable.value : []),
        // A list that can't be read marks no row, rather than guessing which skills the workspace's turns may load.
        ...(turnSkills.ok ? { turnSkillIds: new Set(turnSkills.value.map((skill) => skill.skillId)) } : {}),
        shippedSkillDirs: this.sources.shippedSkillDirs(),
        // Plugin records that can't be read mark no skill, rather than guessing which came with a plugin.
        ...(pluginSkills.ok
          ? { pluginSkills: pluginSkills.value.fromPlugin, removedPluginSkills: pluginSkills.value.removed }
          : {}),
        packSnapshotIds,
      }),
      // Absent when the catalog couldn't be read, or when it cut its candidate list off.
      ...(candidatesWaiting === undefined ? {} : { candidatesWaiting }),
      operatorApprovalSkip,
      issues,
      generatedAt: new Date().toISOString(),
    };
  }

  /** One skill the workspace loaded, whatever its choices. An id the workspace doesn't load is not found. */
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

  /**
   * The workspace's installs still on their way in, or stopped on the way, newest first, from the newest checks Skill
   * Hub lists: an install left between its two steps is found again after a reload. With a `snapshotId`, just that one
   * check at whatever step it is on, done, passed and blocked included (none when the list doesn't hold it), so an
   * install flow can tell a finished install from a declined one (Ruling R55). A check whose source can't be named
   * without a server path (one only the old Skill Hub routes can make) is left out. Without the checks there is nothing
   * to show, so a failure is a plain 503 rather than an empty list.
   */
  public async installs(workspaceId: string, snapshotId?: string): Promise<CapabilitySkillInstallsResponse> {
    const [hub, operatorApprovalSkip] = await Promise.all([
      this.attempt("skill_hub", () => this.sources.listSkillHub({ workspaceId, limit: SKILL_HUB_LIST_LIMIT })),
      this.readOperatorApprovalSkip(),
    ]);
    if (!hub.ok) throw new ServiceUnavailableError(UNREADABLE_INSTALLS);
    return {
      workspaceId,
      installs: hub.value.items.flatMap((item) => {
        if (snapshotId !== undefined && item.snapshotId !== snapshotId) return [];
        const install = buildCapabilitySkillInstall(item);
        if (!install) return [];
        return snapshotId !== undefined || isUnfinishedInstall(install) ? [install] : [];
      }),
      operatorApprovalSkip,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * The Skill Hub checks that read one of GoatCitadel's own pack folders on this install, among the checks the shipped
   * skills in the list were switched on from (Ruling R43). A Hub activation records its check's id as the skill's
   * source; only that check knows the pack folder it read. At most one read per shipped skill; a check that can't be
   * read leaves its skill imported.
   */
  private async readPackSnapshotIds(skills: readonly SkillListItem[]): Promise<ReadonlySet<string>> {
    const packs = this.sources.shippedSkillDirs().packs;
    const snapshotIds = new Set(
      skills.flatMap((skill) => {
        const provenance = skill.lifecycle?.provenance;
        return Object.hasOwn(SHIPPED_SKILL_CATEGORIES, skill.skillId) &&
          provenance?.source === "extra" &&
          provenance.sourceRef
          ? [provenance.sourceRef]
          : [];
      }),
    );
    const checks = await Promise.all(
      [...snapshotIds].map(async (snapshotId) => {
        const read = await this.attempt("skill_hub_check", () => this.sources.findSkillHubSnapshot(snapshotId));
        const check = read.ok ? read.value : undefined;
        return check?.sourceType === "local_path" && packs.has(check.sourceRef) ? [snapshotId] : [];
      }),
    );
    return new Set(checks.flat());
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
    return await allowsOperatorApprovalSkip(this.sources.deploymentProfile(), async () => {
      const setting = await this.attempt("approval_skip", () => this.sources.readApprovalSkipSetting());
      return setting.ok && setting.value;
    });
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
