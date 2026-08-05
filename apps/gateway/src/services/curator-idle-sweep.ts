import type { SkillListItem } from "@goatcitadel/contracts";
import { computeSkillImmunity, gradeSkillUsage } from "./curator-grader.js";

/**
 * S3 — Curator idle janitor (pure sweep logic).
 *
 * The agent authors `self_generated` / `candidate` skills (S2). Over time these
 * sprawl, so this sweep consolidates/archives them. It REUSES the curator's
 * existing deterministic transitions ({@link computeSkillImmunity} +
 * {@link gradeSkillUsage}) — exactly the rubric `CuratorService.runCurator`
 * applies — but scopes the sweep to agent-created skills only.
 *
 * This module is pure: it never touches disk, the clock, or feature flags. The
 * owning {@link CuratorService} method injects the skill list, the archive
 * callback, the snapshot callback, and (under full autonomy) decides whether
 * archives/merges auto-apply. The maintenance tick gates the whole call on the
 * workspace being idle (no active turns), so the janitor never runs mid-turn.
 *
 * Safety guarantees enforced here:
 *  - only `category:"self_generated"` skills are ever considered,
 *  - `pinned` / built-in / bundled skills are exempt (immunity short-circuit),
 *  - archive is reversible: a snapshot is captured BEFORE the disable, and
 *    archive only ever disables (never hard-deletes / prunes files),
 *  - near-duplicate detection PROPOSES a merge (or auto-applies the archive of
 *    the lower-value duplicate under full autonomy) but never hard-deletes,
 *  - when autonomy is off the sweep is proposal-only (no callback mutates).
 */

/** How a self-generated skill is recognized from a {@link SkillListItem}. */
export function isSelfGeneratedSkill(skill: SkillListItem): boolean {
  return skill.lifecycle?.category === "self_generated" || skill.capabilityCategory === "self_generated";
}

/** Whether a skill is already curator-archived (disabled with the archive note). */
function isAlreadyArchived(skill: SkillListItem): boolean {
  return skill.state === "disabled" && (skill.note?.startsWith("curator:archived") ?? false);
}

/**
 * Default near-duplicate similarity: Jaccard overlap of the normalized
 * name/title token sets. Cheap, deterministic, and provider-free. Semantic
 * dedup quality improves once W2 (a real embedding provider) lands — callers
 * may inject {@link CuratorIdleSweepDeps.similarity} to use pseudo-embedding
 * cosine instead, but pseudo-hash embeddings give only wiring-level value, so
 * name/title overlap stays the default.
 */
export function nameTitleSimilarity(a: SkillListItem, b: SkillListItem): number {
  const tokensA = tokenizeSkillLabel(a);
  const tokensB = tokenizeSkillLabel(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenizeSkillLabel(skill: SkillListItem): Set<string> {
  const raw = `${skill.name ?? ""} ${skill.skillId ?? ""}`.toLowerCase();
  const tokens = raw
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return new Set(tokens);
}

/** A proposed/applied archive of a stale self-generated skill. */
export interface CuratorIdleArchiveEntry {
  skillId: string;
  name: string;
  score: number;
  signals: string[];
  /** Whether the archive was actually applied (full autonomy) vs proposed. */
  applied: boolean;
  reason: string;
}

/** A proposed/applied merge of a near-duplicate pair. */
export interface CuratorIdleMergeEntry {
  /** Surviving skill (higher usage / more recent). */
  keepSkillId: string;
  /** Lower-value duplicate that is archived (never hard-deleted). */
  archiveSkillId: string;
  similarity: number;
  /** Whether the duplicate archive was applied (full autonomy) vs proposed. */
  applied: boolean;
}

export interface CuratorIdleSweepResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** True when the sweep auto-applied (full autonomy); false ⇒ proposals only. */
  autoApplied: boolean;
  scannedSelfGenerated: number;
  immuneCount: number;
  archives: CuratorIdleArchiveEntry[];
  merges: CuratorIdleMergeEntry[];
}

export interface CuratorIdleSweepDeps {
  /** Full skill registry (the sweep filters to self_generated itself). */
  listSkills: () => Promise<SkillListItem[]>;
  /** Monotonic clock for timestamps. */
  now: () => Date;
  /** Stable run id (e.g. `curator-idle-<uuid>`). */
  runId: string;
  /**
   * Full autonomy ⇒ archives/merges auto-apply (snapshotted + reversible).
   * False ⇒ the sweep records proposals only and never invokes
   * {@link snapshotSkill} / {@link archiveSkill}.
   */
  autoApply: boolean;
  /**
   * Capture a reversible snapshot of a skill BEFORE it is archived. Called only
   * when {@link autoApply} is true, immediately before {@link archiveSkill}.
   */
  snapshotSkill: (skillId: string) => Promise<void> | void;
  /** Archive (disable + curator note) a self-generated skill. Reversible. */
  archiveSkill: (skillId: string, reason: string) => Promise<void>;
  /**
   * Near-duplicate similarity in [0,1]. Defaults to {@link nameTitleSimilarity}.
   * Inject a pseudo-embedding cosine (or a real W2 embedding) for better recall.
   */
  similarity?: (a: SkillListItem, b: SkillListItem) => number;
  /** Min similarity to treat two skills as near-duplicates (default 0.6). */
  duplicateThreshold?: number;
}

const DEFAULT_DUPLICATE_THRESHOLD = 0.6;

/**
 * Run one idle-gated curator sweep over self-generated skills.
 *
 * Deterministic and side-effect-free except via the injected
 * {@link CuratorIdleSweepDeps.snapshotSkill} / {@link CuratorIdleSweepDeps.archiveSkill}
 * callbacks, which are invoked only when {@link CuratorIdleSweepDeps.autoApply}
 * is true. Immune skills (pinned / built-in / bundled) are never touched. A skill
 * archived as a stale candidate is never also considered for a merge.
 */
export async function planCuratorIdleSweep(deps: CuratorIdleSweepDeps): Promise<CuratorIdleSweepResult> {
  const startedAt = deps.now();
  const similarity = deps.similarity ?? nameTitleSimilarity;
  const duplicateThreshold = deps.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;

  const selfGenerated = (await deps.listSkills()).filter(isSelfGeneratedSkill);
  const archives: CuratorIdleArchiveEntry[] = [];
  const merges: CuratorIdleMergeEntry[] = [];
  const archivedIds = new Set<string>();
  let immuneCount = 0;

  // Pass 1 — deterministic stale/archive transitions (reuse the curator rubric).
  for (const skill of selfGenerated) {
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      immuneCount += 1;
      continue;
    }
    if (isAlreadyArchived(skill)) {
      continue;
    }
    const grade = gradeSkillUsage({ skill, now: startedAt });
    if (grade.recommendation !== "archive") {
      continue;
    }
    const reason = "curator:archived idle_self_generated_stale";
    if (deps.autoApply) {
      // Snapshot BEFORE the disable so the archive is fully reversible.
      await deps.snapshotSkill(skill.skillId);
      await deps.archiveSkill(skill.skillId, reason);
    }
    archivedIds.add(skill.skillId);
    archives.push({
      skillId: skill.skillId,
      name: skill.name,
      score: grade.score.mean,
      signals: grade.signals,
      applied: deps.autoApply,
      reason,
    });
  }

  // Pass 2 — near-duplicate detection over the *remaining* live self-generated
  // skills. The lower-value duplicate is archived (never hard-deleted); the
  // higher-value one survives. Immune skills are never archived as a duplicate.
  const survivors = selfGenerated.filter(
    (skill) => !archivedIds.has(skill.skillId) && !isAlreadyArchived(skill) && !computeSkillImmunity(skill).immune,
  );
  for (let i = 0; i < survivors.length; i += 1) {
    const left = survivors[i];
    if (!left || archivedIds.has(left.skillId)) {
      continue;
    }
    for (let j = i + 1; j < survivors.length; j += 1) {
      const right = survivors[j];
      if (!right || archivedIds.has(right.skillId) || archivedIds.has(left.skillId)) {
        continue;
      }
      const score = similarity(left, right);
      if (score < duplicateThreshold) {
        continue;
      }
      const keep = preferSurvivor(left, right);
      const archive = keep === left ? right : left;
      const reason = `curator:archived idle_self_generated_duplicate of ${keep.skillId}`;
      if (deps.autoApply) {
        await deps.snapshotSkill(archive.skillId);
        await deps.archiveSkill(archive.skillId, reason);
      }
      archivedIds.add(archive.skillId);
      merges.push({
        keepSkillId: keep.skillId,
        archiveSkillId: archive.skillId,
        similarity: score,
        applied: deps.autoApply,
      });
    }
  }

  return {
    runId: deps.runId,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    autoApplied: deps.autoApply,
    scannedSelfGenerated: selfGenerated.length,
    immuneCount,
    archives,
    merges,
  };
}

/**
 * Pick the survivor of a near-duplicate pair: higher usage wins; ties break on
 * the more-recent `lastUsedAt`; final tie breaks on skill id for determinism.
 */
function preferSurvivor(a: SkillListItem, b: SkillListItem): SkillListItem {
  const usageA = a.usageCount ?? 0;
  const usageB = b.usageCount ?? 0;
  if (usageA !== usageB) {
    return usageA > usageB ? a : b;
  }
  const lastA = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
  const lastB = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
  if (Number.isFinite(lastA) && Number.isFinite(lastB) && lastA !== lastB) {
    return lastA > lastB ? a : b;
  }
  return a.skillId <= b.skillId ? a : b;
}
