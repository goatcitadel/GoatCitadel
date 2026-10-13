import { GENERATED_BUNDLED_SKILL_LOCK } from "./bundled-skill-lock.generated.js";

/** Version tag carried by audit evidence that cites the compiled bundled-skill lock. */
export const BUNDLED_SKILL_LOCK_VERSION = "goatcitadel.bundled-skill-lock.v1" as const;

/**
 * Release-bound exact-byte identity of one skill tree shipped under `skills/bundled`.
 *
 * The gateway binds built-in skill lifecycle rows to exact bytes. Without this lock every
 * release that edits a bundled skill looks identical to tampering on an upgraded install, so the
 * row is demoted to a non-callable candidate with no operator path back. The lock lets the
 * gateway tell "the release shipped new bytes" (tree equals the compiled entry) apart from "bytes
 * changed on disk unexpectedly" (tree matches nothing the release vouched for).
 */
export interface BundledSkillLockEntry {
  readonly skillId: string;
  readonly manifestVersion: "goatcitadel.skill-tree.v1";
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

// Frozen copies: the lock is trust-bearing data, so no caller can mutate an entry in place.
const FROZEN_LOCK: readonly BundledSkillLockEntry[] = Object.freeze(
  GENERATED_BUNDLED_SKILL_LOCK.map((entry) => Object.freeze({ ...entry })),
);

const LOCK_BY_SKILL_ID: ReadonlyMap<string, BundledSkillLockEntry> = new Map(
  FROZEN_LOCK.map((entry) => [entry.skillId, entry]),
);

export function resolveBundledSkillLockEntry(skillId: string): BundledSkillLockEntry | undefined {
  return LOCK_BY_SKILL_ID.get(skillId);
}

export function listBundledSkillLockEntries(): readonly BundledSkillLockEntry[] {
  return FROZEN_LOCK;
}
