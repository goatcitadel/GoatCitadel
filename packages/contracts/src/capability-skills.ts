// ---------------------------------------------------------------------------
// Skill use counts: GET /api/v1/capabilities/skills/usage
// ---------------------------------------------------------------------------

/** How far back the use counts reach. */
export const SKILL_USAGE_WINDOW_DAYS = 365;

/** One skill's chat turns in the window. A turn counts once for a skill, however often its profile lists it. */
export interface CapabilitySkillUsageEntry {
  skillId: string;
  uses: number;
  lastUsedAt: string;
}

export interface CapabilitySkillUsageResponse {
  /** The start of the window: now minus `SKILL_USAGE_WINDOW_DAYS`, ISO. */
  since: string;
  /** When the counts were read. A cached answer keeps the time of the read that filled the cache. */
  generatedAt: string;
  /** Only skills with at least one use, ordered by skill id. A skill that is not listed has no use in the window. */
  skills: CapabilitySkillUsageEntry[];
}
