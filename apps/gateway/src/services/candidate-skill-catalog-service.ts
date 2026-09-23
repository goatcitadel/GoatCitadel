import {
  ConflictError,
  type CandidateSkillVersionRecord,
  type SkillLifecycleRecord,
  type SkillListItem,
  type SkillRuntimeState,
  type SkillStateRecord,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
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
    const loaded = await loadApprovedCandidateSkillOrQuarantine(deps, candidateRoot, version, workspaceId);
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

/**
 * An approved bundle that no longer loads (changed after review, partly deleted, invalid name) is left out of
 * both catalogs rather than failing turn admission for its whole workspace; re-review restores it.
 */
async function loadApprovedCandidateSkillOrQuarantine(
  deps: CandidateSkillCatalogDependencies,
  candidateRoot: string,
  version: CandidateSkillVersionRecord,
  workspaceId: string,
): Promise<Awaited<ReturnType<typeof loadApprovedCandidateSkill>>> {
  try {
    return await loadApprovedCandidateSkill({ rootDir: deps.rootDir, candidateRoot, version, workspaceId });
  } catch (error) {
    logger.warn("Quarantined an approved candidate skill bundle that no longer loads; review it again to restore it.", {
      workspaceId,
      candidateId: version.candidateId,
      versionId: version.versionId,
      reason: quarantineReason(error),
    });
    return undefined;
  }
}

/** Fixed review messages and error codes only: bundle content never reaches the log. */
function quarantineReason(error: unknown): string {
  if (error instanceof ConflictError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
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
