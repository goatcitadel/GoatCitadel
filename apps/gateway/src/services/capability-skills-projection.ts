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
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";
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

/**
 * Where a skill came from. Bundled skills are built in, and so is a shipped skill (pinned in `SHIPPED_SKILL_CATEGORIES`)
 * whose provenance shows it came from GoatCitadel itself. Approved workspace candidates are self-authored; the
 * workspace skills folder is the workspace's. Everything else, including Skill Hub installs, a Git import that shares
 * a shipped skill's name and the `.assistant/skills` folder (nothing in GoatCitadel writes it), is imported.
 */
export function skillOriginFor(skill: OriginFacts, shipped: ShippedSkillDirs): SkillOrigin {
  if (skill.source === "bundled" || cameFromGoatCitadel(skill, shipped)) return "built_in";
  if (skill.capabilityCategory === "self_generated") return "self_authored";
  if (skill.source === "workspace") return "workspace";
  return "imported";
}

/**
 * A shipped id alone proves nothing: anyone can name a skill `github-cli` (Ruling R13). It counts as GoatCitadel's own
 * only when it loaded from one of GoatCitadel's own folders, or its recorded source is one of GoatCitadel's own pack
 * folders on this install, a local path no Git or remote-bundle source can be. Provenance that can't tell (none
 * recorded, or a pack folder from another install) reads as imported, which errs toward less trust.
 */
function cameFromGoatCitadel(skill: OriginFacts, shipped: ShippedSkillDirs): boolean {
  if (!Object.hasOwn(SHIPPED_SKILL_CATEGORIES, skill.skillId)) return false;
  if (shipped.folders.has(skill.dir)) return true;
  const provenance = skill.lifecycle?.provenance;
  return (
    provenance?.sourceProvider === "local" &&
    provenance.sourceRef !== undefined &&
    shipped.packs.has(provenance.sourceRef)
  );
}

/**
 * The skills the workspace's choices leave out. "ALL" keeps every skill, approved self-authored ones included, which is
 * the same rule the skill list and catalog routes filter by. An unreadable choice (`undefined`) hides nothing.
 */
export function hiddenSkillIds(
  knownSkillIds: readonly string[],
  effective: EffectiveCapabilitySet | undefined,
): Set<string> {
  if (effective === undefined || effective === "ALL") return new Set();
  return new Set(knownSkillIds.filter((skillId) => !effective.has(skillId)));
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
 * Candidate skills still waiting for review. The catalog lists one entry per version
 * (`candidate:<candidateId>:<versionId>`), so a candidate counts once however many of its versions wait.
 */
export function countWaitingCandidates(catalog: readonly CapabilityCatalogEntry[]): number {
  const waiting = new Set<string>();
  for (const entry of catalog) {
    if (entry.kind !== "candidate_skill" || entry.lifecycleState !== "candidate") continue;
    const candidateId = entry.candidateId ?? entry.capabilityId.split(":")[1];
    if (candidateId) waiting.add(candidateId);
  }
  return waiting.size;
}

/**
 * One row per loaded skill, ordered by name and then id in plain code-unit order, so no locale changes it. A skill is
 * switchable only when the skill state owner's own lookup holds it.
 */
export function buildCapabilitySkillItems(input: {
  skills: readonly SkillListItem[];
  hiddenSkillIds: ReadonlySet<string>;
  pendingApprovalIds: ReadonlyMap<string, string>;
  switchableSkillIds: ReadonlySet<string>;
  shippedSkillDirs: ShippedSkillDirs;
}): CapabilitySkillItem[] {
  return input.skills
    .map((skill): CapabilitySkillItem => {
      const pendingApprovalId = input.pendingApprovalIds.get(skill.skillId);
      return {
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description ?? "",
        category: skillCategoryFor({ skillId: skill.skillId, tags: skill.tags, keywords: skill.keywords }),
        origin: skillOriginFor(skill, input.shippedSkillDirs),
        state: STATE_BY_RUNTIME_STATE[skill.state],
        // As the skill list reports it; a missing value never claims the AI can use the skill.
        callable: skill.callable === true,
        revision: skill.revision,
        switchable: input.switchableSkillIds.has(skill.skillId),
        pinned: skill.pinned === true,
        ...(skill.lifecycleState ? { lifecycleState: skill.lifecycleState } : {}),
        tags: [...(skill.tags ?? [])],
        hiddenInWorkspace: input.hiddenSkillIds.has(skill.skillId),
        ...(pendingApprovalId ? { pendingApprovalId } : {}),
      };
    })
    .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.skillId, b.skillId));
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
