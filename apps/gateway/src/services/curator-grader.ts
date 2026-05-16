import type { SkillListItem, CuratorSkillScore, CuratorSkillRecommendation } from "@goatcitadel/contracts";

export interface SkillImmunityResult {
  immune: boolean;
  reason?: "bundled" | "pinned";
}

export function computeSkillImmunity(skill: SkillListItem): SkillImmunityResult {
  if (skill.source === "bundled") {
    return { immune: true, reason: "bundled" };
  }
  if (skill.pinned === true) {
    return { immune: true, reason: "pinned" };
  }
  return { immune: false };
}

export interface GradeSkillUsageInput {
  skill: SkillListItem;
  now: Date;
}

export interface GradeSkillUsageResult {
  score: CuratorSkillScore;
  signals: string[];
  recommendation: CuratorSkillRecommendation;
  ageDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_USAGE_DAYS = 90;
const ARCHIVE_THRESHOLD = 0.4;

export function gradeSkillUsage(input: GradeSkillUsageInput): GradeSkillUsageResult {
  const { skill, now } = input;
  const signals: string[] = [];
  const usage = skill.usageCount ?? 0;
  const lastUsed = skill.lastUsedAt ? new Date(skill.lastUsedAt) : undefined;
  const ageDays = lastUsed
    ? Math.max(0, Math.floor((now.getTime() - lastUsed.getTime()) / DAY_MS))
    : Number.POSITIVE_INFINITY;

  let honesty = 0.7;
  let blockerQuality = 0.7;
  let retryQuality = 0.7;
  let toolEvidence = 0.65;
  let actionability = 0.7;

  if (usage === 0) {
    honesty = 0.45;
    blockerQuality = 0.4;
    retryQuality = 0.45;
    toolEvidence = 0.35;
    actionability = 0.4;
    signals.push("never_used");
  } else if (usage >= 50) {
    honesty = 0.86;
    toolEvidence = 0.85;
    actionability = 0.82;
    signals.push("high_usage");
  } else if (usage >= 10) {
    toolEvidence = 0.74;
    actionability = 0.74;
    signals.push("moderate_usage");
  }

  if (Number.isFinite(ageDays) && ageDays > STALE_USAGE_DAYS) {
    blockerQuality = Math.min(blockerQuality, 0.42);
    retryQuality = Math.min(retryQuality, 0.42);
    actionability = Math.min(actionability, 0.42);
    signals.push("stale_usage");
  } else if (Number.isFinite(ageDays) && ageDays <= 7 && usage > 0) {
    blockerQuality = Math.max(blockerQuality, 0.78);
    signals.push("recent_usage");
  }

  const mean = (honesty + blockerQuality + retryQuality + toolEvidence + actionability) / 5;
  const score: CuratorSkillScore = {
    honesty,
    blockerQuality,
    retryQuality,
    toolEvidence,
    actionability,
    mean,
  };

  let recommendation: CuratorSkillRecommendation = "keep";
  if (mean < ARCHIVE_THRESHOLD) {
    recommendation = "archive";
  } else if (mean < 0.55 && usage === 0) {
    recommendation = "archive";
    // Stale-usage archive: low-mean (<0.55) skills with stale_usage signal, even when usageCount > 0.
  } else if (mean < 0.55 && signals.includes("stale_usage")) {
    recommendation = "archive";
  }

  return {
    score,
    signals,
    recommendation,
    ageDays: Number.isFinite(ageDays) ? ageDays : Number.MAX_SAFE_INTEGER,
  };
}
