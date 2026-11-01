import {
  SHIPPED_SKILL_CATEGORIES,
  SKILL_LIFECYCLE_APPROVAL_KIND,
  skillCategoryFor,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type CapabilitySkillDetail,
  type CapabilitySkillItem,
  type CapabilitySkillState,
  type SkillListItem,
  type SkillOrigin,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import { parseSkillLifecycleApprovalBinding } from "./skill-governance-journey-producer.js";

const STATE_BY_RUNTIME_STATE: Readonly<Record<SkillRuntimeState, CapabilitySkillState>> = {
  enabled: "on",
  sleep: "paused",
  disabled: "off",
};

/** Where GoatCitadel's own skills outside `skills/bundled` come from on this install. */
export interface ShippedSkillDirs {
  /** Folders GoatCitadel ships its own `extra` skills in, such as `skills/genie-npu-ir20`: a skill's `dir` there. */
  readonly folders: ReadonlySet<string>;
  /**
   * The folder Skill Hub reads each of GoatCitadel's own packs from (`skills/import-packs/<packId>`). A skill installed
   * from one records that folder as its local source.
   */
  readonly packs: ReadonlySet<string>;
}

type OriginFacts = Pick<SkillListItem, "skillId" | "source" | "capabilityCategory" | "dir" | "lifecycle">;

/** No Skill Hub check of GoatCitadel's own packs is known. */
const NO_PACK_SNAPSHOTS: ReadonlySet<string> = new Set();

/**
 * Where a skill came from. Bundled skills are built in, and so is a shipped skill (pinned in `SHIPPED_SKILL_CATEGORIES`)
 * whose provenance shows it came from GoatCitadel itself. Approved workspace candidates are self-authored; the
 * workspace skills folder is the workspace's. Everything else, including Skill Hub installs, a Git import that shares
 * a shipped skill's name and the `.assistant/skills` folder (nothing in GoatCitadel writes it), is imported.
 */
export function skillOriginFor(
  skill: OriginFacts,
  shipped: ShippedSkillDirs,
  packSnapshotIds: ReadonlySet<string> = NO_PACK_SNAPSHOTS,
): SkillOrigin {
  if (skill.source === "bundled" || cameFromGoatCitadel(skill, shipped, packSnapshotIds)) return "built_in";
  if (skill.capabilityCategory === "self_generated") return "self_authored";
  if (skill.source === "workspace") return "workspace";
  return "imported";
}

/**
 * A shipped id alone proves nothing: anyone can name a skill `github-cli` (Ruling R13). It counts as GoatCitadel's own
 * only when it loaded from one of GoatCitadel's own folders, or its recorded source is one of GoatCitadel's own pack
 * folders on this install, a local path no Git or remote-bundle source can be. A pack switched on through Skill Hub
 * records the Hub check it came from instead (its snapshot id), so it counts when that check read one of those pack
 * folders (`packSnapshotIds`, Ruling R43). Provenance that can't tell (none recorded, a pack folder from another
 * install, or a check that can't be read) reads as imported, which errs toward less trust.
 */
function cameFromGoatCitadel(
  skill: OriginFacts,
  shipped: ShippedSkillDirs,
  packSnapshotIds: ReadonlySet<string>,
): boolean {
  if (!Object.hasOwn(SHIPPED_SKILL_CATEGORIES, skill.skillId)) return false;
  if (shipped.folders.has(skill.dir)) return true;
  const provenance = skill.lifecycle?.provenance;
  if (provenance?.sourceRef === undefined) return false;
  if (provenance.sourceProvider === "local" && shipped.packs.has(provenance.sourceRef)) return true;
  return provenance.source === "extra" && packSnapshotIds.has(provenance.sourceRef);
}

/**
 * The waiting `skill.lifecycle` approval for each skill whose single-skill change it would apply, keyed by skill id.
 * Batch and activation-policy approvals name no one skill, and a payload that doesn't parse is ignored. The newest
 * approval wins when a skill has two.
 */
export function pendingSkillApprovalIds(approvals: readonly ApprovalRequest[]): Map<string, string> {
  const newest = new Map<string, ApprovalRequest>();
  for (const approval of approvals) {
    if (approval.kind !== SKILL_LIFECYCLE_APPROVAL_KIND || approval.status !== "pending") continue;
    const binding = parseSkillLifecycleApprovalBinding(approval.payload?.skillLifecycle);
    if (binding?.subjectKind !== "skill" || !binding.subjectId) continue;
    const current = newest.get(binding.subjectId);
    if (!current || approval.createdAt > current.createdAt) newest.set(binding.subjectId, approval);
  }
  return new Map([...newest].map(([skillId, approval]) => [skillId, approval.approvalId]));
}

/**
 * How many candidate skill versions the catalog lists at most: the most recently updated ones, across the whole
 * install (`candidateSkillVersions.list(200)` in CapabilitySystemService's catalog).
 */
export const CATALOG_CANDIDATE_VERSION_LIMIT = 200;

/**
 * Candidate skills still waiting for review, across the whole install. The catalog lists one entry per version
 * (`candidate:<candidateId>:<versionId>`), so a candidate counts once however many of its versions wait. When the
 * catalog's candidate entries reach its limit, older ones may be cut off, so there is no count rather than an
 * undercount shown as exact.
 */
export function countWaitingCandidates(catalog: readonly CapabilityCatalogEntry[]): number | undefined {
  const candidateEntries = catalog.filter((entry) => entry.kind === "candidate_skill");
  if (candidateEntries.length >= CATALOG_CANDIDATE_VERSION_LIMIT) return undefined;
  const waiting = new Set<string>();
  for (const entry of candidateEntries) {
    if (entry.lifecycleState !== "candidate") continue;
    const candidateId = entry.candidateId ?? entry.capabilityId.split(":")[1];
    if (candidateId) waiting.add(candidateId);
  }
  return waiting.size;
}

/**
 * One row per loaded skill, ordered by name and then id in plain code-unit order, so no locale changes it. A skill is
 * switchable only when the skill state owner's own lookup holds it. A skill is left out of the workspace when the ids
 * its turns may load (`turnSkillIds`) don't hold it; without them no row makes the claim.
 */
export function buildCapabilitySkillItems(input: {
  skills: readonly SkillListItem[];
  pendingApprovalIds: ReadonlyMap<string, string>;
  switchableSkillIds: ReadonlySet<string>;
  /** The ids of the skills the workspace's turns may load. Absent when they couldn't be read. */
  turnSkillIds?: ReadonlySet<string>;
  shippedSkillDirs: ShippedSkillDirs;
  /** The Skill Hub checks plugin records list as their skills, with the plugin. Absent when they couldn't be read. */
  pluginSkills?: ReadonlyMap<string, { pluginId: string; name: string }>;
  /** The Skill Hub checks that read one of GoatCitadel's own pack folders on this install. */
  packSnapshotIds?: ReadonlySet<string>;
}): CapabilitySkillItem[] {
  return input.skills
    .map((skill): CapabilitySkillItem => {
      const pendingApprovalId = input.pendingApprovalIds.get(skill.skillId);
      const fromPlugin = pluginOf(skill, input.pluginSkills);
      return {
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description ?? "",
        category: skillCategoryFor({ skillId: skill.skillId, tags: skill.tags, keywords: skill.keywords }),
        origin: skillOriginFor(skill, input.shippedSkillDirs, input.packSnapshotIds),
        state: STATE_BY_RUNTIME_STATE[skill.state],
        // As the skill list reports it; a missing value never claims the AI can use the skill.
        callable: skill.callable === true,
        revision: skill.revision,
        switchable: input.switchableSkillIds.has(skill.skillId),
        ...(input.turnSkillIds ? { leftOutOfWorkspace: !input.turnSkillIds.has(skill.skillId) } : {}),
        pinned: skill.pinned === true,
        ...(skill.lifecycleState ? { lifecycleState: skill.lifecycleState } : {}),
        tags: [...(skill.tags ?? [])],
        ...(pendingApprovalId ? { pendingApprovalId } : {}),
        ...(fromPlugin ? { fromPlugin: { pluginId: fromPlugin.pluginId, name: fromPlugin.name } } : {}),
      };
    })
    .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.skillId, b.skillId));
}

/**
 * The plugin whose record lists the Skill Hub check a skill was switched on from. Switching on through Skill Hub records
 * that check's id as the skill's `extra` source; nothing else counts, so a skill a plugin didn't bring is never marked.
 */
function pluginOf(
  skill: Pick<SkillListItem, "lifecycle">,
  pluginSkills: ReadonlyMap<string, { pluginId: string; name: string }> | undefined,
): { pluginId: string; name: string } | undefined {
  const provenance = skill.lifecycle?.provenance;
  if (provenance?.source !== "extra" || !provenance.sourceRef) return undefined;
  return pluginSkills?.get(provenance.sourceRef);
}

/** The panel's details for one skill, with the catalog's `skill:<id>` entry when there is one. */
export function buildCapabilitySkillDetail(
  skill: SkillListItem,
  catalogEntry: CapabilityCatalogEntry | undefined,
): CapabilitySkillDetail {
  const provenance = skill.lifecycle?.provenance;
  return {
    skillId: skill.skillId,
    instructionBody: skill.instructionBody,
    keywords: [...skill.keywords],
    declaredTools: [...skill.declaredTools],
    requires: [...skill.requires],
    ...(provenance
      ? {
          provenance: {
            source: provenance.source,
            ...(provenance.sourceRef ? { sourceRef: provenance.sourceRef } : {}),
            ...(provenance.sourceProvider ? { sourceProvider: provenance.sourceProvider } : {}),
            ...(provenance.commitSha ? { commitSha: provenance.commitSha } : {}),
            ...(provenance.contentIntegrity ? { treeSha256: provenance.contentIntegrity.treeSha256 } : {}),
          },
        }
      : {}),
    ...(skill.trustLabel ? { trustLabel: skill.trustLabel } : {}),
    ...(skill.reviewWarning ? { reviewWarning: skill.reviewWarning } : {}),
    ...(skill.note ? { note: skill.note } : {}),
    ...(skill.stateUpdatedAt ? { stateUpdatedAt: skill.stateUpdatedAt } : {}),
    ...(catalogEntry ? { catalogEntry } : {}),
  };
}

function compareCodeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
