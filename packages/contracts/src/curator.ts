import type { SkillRuntimeState } from "./skills.js";

export type CuratorSkillImmunityReason = "bundled" | "pinned" | "missing_state";

export interface CuratorSkillScore {
  honesty: number;
  blockerQuality: number;
  retryQuality: number;
  toolEvidence: number;
  actionability: number;
  mean: number;
}

export type CuratorSkillRecommendation = "keep" | "archive" | "prune_candidate" | "consolidate_candidate";

export interface CuratorSkillStatusItem {
  skillId: string;
  name: string;
  source: "bundled" | "managed" | "workspace" | "extra";
  pinned: boolean;
  bundled: boolean;
  immune: boolean;
  immunityReason?: CuratorSkillImmunityReason;
  state: SkillRuntimeState;
  usageCount: number;
  lastUsedAt?: string;
  ageDays: number;
  score: CuratorSkillScore;
  signals: string[];
  recommendation: CuratorSkillRecommendation;
  consolidationGroup?: string;
  archived: boolean;
  archivedAt?: string;
}

export interface CuratorStatusResponse {
  generatedAt: string;
  cycleDays: number;
  workspaceId?: string;
  items: CuratorSkillStatusItem[];
}

export interface CuratorArchiveRequest {
  skillId: string;
  reason?: string;
  actorId?: string;
}

export interface CuratorArchiveResponse {
  skillId: string;
  archived: boolean;
  archivedAt: string;
  state: SkillRuntimeState;
}

export interface CuratorPruneRequest {
  skillId: string;
  confirm: true;
  actorId?: string;
}

export interface CuratorPruneResponse {
  skillId: string;
  pruned: true;
  prunedAt: string;
  filesRemoved: string[];
}

export interface CuratorListArchivedResponse {
  generatedAt: string;
  items: CuratorSkillStatusItem[];
}

export interface CuratorRunRequest {
  sync?: boolean;
  dryRun?: boolean;
  actorId?: string;
}

export interface CuratorRunReportEntry {
  skillId: string;
  name: string;
  recommendation: CuratorSkillRecommendation;
  score: CuratorSkillScore;
  signals: string[];
  action: "none" | "archived" | "skipped_immune" | "skipped_below_threshold";
  actionReason?: string;
}

export interface CuratorRunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  triggerMode: "manual" | "scheduled" | "synchronous";
  dryRun: boolean;
  cycleDays: number;
  totalSkills: number;
  immuneCount: number;
  scoredCount: number;
  archivedCount: number;
  prunedCount: number;
  consolidationGroupCount: number;
  entries: CuratorRunReportEntry[];
  reportDir: string;
}

export interface CuratorRunResponse {
  runId: string;
  scheduled: boolean;
  report?: CuratorRunReport;
}

export type CuratorScopeKind = "skill" | "memory";

export interface CuratorScopeViolation {
  attemptedKind: CuratorScopeKind | string;
  reason: string;
}

export interface CuratorScopeAuditRecord {
  recordId: string;
  runId: string;
  occurredAt: string;
  violation: CuratorScopeViolation;
}
