import type {
  CandidateSkillVersionRecord,
  SkillLifecycleRecord,
  SkillListItem,
  SkillRuntimeState,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { loadApprovedCandidateSkill } from "./candidate-runtime-skills.js";
import { readCandidateSkillArtifacts } from "./candidate-skill-artifact-review.js";

interface CandidateSkillCatalogDependencies {
  rootDir: string;
  storage: Pick<AsyncStorage, "candidateSkillVersions" | "skillLifecycle" | "skillAggregateRevisions">;
}

/** Candidate instructions are projected only for their owning workspace. */
export async function listWorkspaceCandidateSkills(
  deps: CandidateSkillCatalogDependencies,
  candidateRoot: string,
  workspaceId: string,
  stateMap: ReadonlyMap<string, SkillStateRecord>,
): Promise<SkillListItem[]> {
  const all: SkillListItem[] = [];
  for (const version of await deps.storage.candidateSkillVersions.listApprovedInstructions(workspaceId, 200)) {
    const loaded = await loadApprovedCandidateSkill({
      rootDir: deps.rootDir,
      candidateRoot,
      version,
      workspaceId,
    });
    if (!loaded) continue;
    const existing = await deps.storage.skillLifecycle.find(loaded.skill.skillId);
    if (!existing || !skillLifecycleProjectionMatches(existing, loaded.lifecycle)) {
      await deps.storage.skillLifecycle.upsert(loaded.lifecycle);
    }
    const state = stateMap.get(loaded.skill.skillId);
    all.push({
      ...loaded.skill,
      lifecycle: loaded.lifecycle,
      lifecycleState: loaded.lifecycle.lifecycleState,
      capabilityCategory: loaded.lifecycle.category,
      trustLabel: loaded.lifecycle.trustLabel,
      reviewWarning: loaded.lifecycle.reviewWarning,
      state: state?.state ?? "enabled",
      revision:
        state?.revision ??
        (await deps.storage.skillAggregateRevisions.ensure("runtime_skill", loaded.skill.skillId)).revision,
      callable: isSkillCallable(loaded.lifecycle, state?.state ?? "enabled"),
      note: state?.note,
      stateUpdatedAt: state?.updatedAt,
      pinned: state?.pinned,
      usageCount: state?.usageCount,
      lastUsedAt: state?.lastUsedAt,
    });
  }
  return all;
}

export function readCandidateCatalogArtifacts(
  deps: Pick<CandidateSkillCatalogDependencies, "rootDir">,
  candidateRoot: string,
  version: CandidateSkillVersionRecord,
  revision: number,
) {
  return readCandidateSkillArtifacts(deps.rootDir, candidateRoot, version, revision);
}

export function skillLifecycleProjectionMatches(left: SkillLifecycleRecord, right: SkillLifecycleRecord): boolean {
  return (
    left.skillId === right.skillId &&
    left.category === right.category &&
    left.lifecycleState === right.lifecycleState &&
    left.trustLabel === right.trustLabel &&
    left.reviewWarning === right.reviewWarning &&
    JSON.stringify(left.provenance) === JSON.stringify(right.provenance)
  );
}

export function isSkillCallable(lifecycle: SkillLifecycleRecord, state: SkillRuntimeState): boolean {
  if (state === "disabled") {
    return false;
  }
  return lifecycle.lifecycleState === "approved" || lifecycle.lifecycleState === "trusted";
}
