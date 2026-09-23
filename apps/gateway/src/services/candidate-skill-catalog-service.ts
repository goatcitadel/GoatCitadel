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

/** An approved bundle that no longer loads, as observed by the latest catalog build; never persisted. */
export interface QuarantinedCandidateSkill {
  readonly candidateId: string;
  readonly versionId: string;
  /** A fixed review message or error code; bundle content never appears here. */
  readonly reason: string;
}

export interface WorkspaceCandidateSkillListing {
  readonly skills: SkillListItem[];
  readonly quarantined: QuarantinedCandidateSkill[];
}

/**
 * Candidate instructions are projected only for their owning workspace. An approved bundle that no longer
 * loads (changed after review, partly deleted, invalid name) is quarantined: left out of both catalogs and
 * reported, rather than failing turn admission for its whole workspace. Re-review restores it.
 */
export async function listWorkspaceCandidateSkills(
  deps: CandidateSkillCatalogDependencies,
  candidateRoot: string,
  workspaceId: string,
  stateMap: ReadonlyMap<string, SkillStateRecord>,
): Promise<WorkspaceCandidateSkillListing> {
  const all: SkillListItem[] = [];
  const quarantined: QuarantinedCandidateSkill[] = [];
  for (const version of await deps.storage.candidateSkillVersions.listApprovedInstructions(workspaceId, 200)) {
    let loaded: Awaited<ReturnType<typeof loadApprovedCandidateSkill>>;
    try {
      loaded = await loadApprovedCandidateSkill({ rootDir: deps.rootDir, candidateRoot, version, workspaceId });
    } catch (error) {
      quarantined.push({
        candidateId: version.candidateId,
        versionId: version.versionId,
        reason: quarantineReason(error),
      });
      continue;
    }
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
  return { skills: all, quarantined };
}

/** A quarantine as last observed; readers outside that workspace's builds see how old it is. */
export interface CandidateQuarantineObservation extends QuarantinedCandidateSkill {
  /** When a workspace-scoped catalog build last found the bundle unloadable (ISO 8601). */
  readonly observedAt: string;
}

/** The last observed quarantine per workspace. It logs transitions rather than every catalog build. */
export class CandidateSkillQuarantine {
  readonly #byWorkspace = new Map<string, ReadonlyMap<string, CandidateQuarantineObservation>>();

  public record(
    workspaceId: string,
    quarantined: readonly QuarantinedCandidateSkill[],
    observedAt = new Date().toISOString(),
  ): void {
    const previous = this.#byWorkspace.get(workspaceId);
    const current = new Map(quarantined.map((entry) => [entry.versionId, { ...entry, observedAt }]));
    for (const entry of current.values()) {
      if (previous?.get(entry.versionId)?.reason === entry.reason) continue;
      logger.warn(
        "Quarantined an approved candidate skill bundle that no longer loads; review it again to restore it.",
        {
          workspaceId,
          candidateId: entry.candidateId,
          versionId: entry.versionId,
          reason: entry.reason,
        },
      );
    }
    for (const entry of previous?.values() ?? []) {
      if (current.has(entry.versionId)) continue;
      logger.info("An approved candidate skill bundle is no longer quarantined.", {
        workspaceId,
        candidateId: entry.candidateId,
        versionId: entry.versionId,
      });
    }
    if (current.size === 0) this.#byWorkspace.delete(workspaceId);
    else this.#byWorkspace.set(workspaceId, current);
  }

  public find(workspaceId: string, versionId: string): CandidateQuarantineObservation | undefined {
    return this.#byWorkspace.get(workspaceId)?.get(versionId);
  }
}

export function describeCandidateQuarantine(entry: CandidateQuarantineObservation): string {
  return `This approved bundle did not load when last checked at ${entry.observedAt} (${entry.reason.replace(/\.$/u, "")}), so it is not offered as a skill. Review it again or restore its reviewed files.`;
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
