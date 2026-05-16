import { randomUUID } from "node:crypto";
import {
  ValidationError,
  type CuratorArchiveRequest,
  type CuratorArchiveResponse,
  type CuratorListArchivedResponse,
  type CuratorPruneRequest,
  type CuratorPruneResponse,
  type CuratorRunReport,
  type CuratorRunReportEntry,
  type CuratorRunRequest,
  type CuratorRunResponse,
  type CuratorSkillStatusItem,
  type CuratorStatusResponse,
  type DurableRunRecord,
  type SkillListItem,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { computeSkillImmunity, gradeSkillUsage } from "./curator-grader.js";
import { getZonedDateParts, toWeekKeyForTimezone } from "./improvement-replay.js";

const CURATOR_WEEKLY_JOB_ID = "curator_weekly";
const CURATOR_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const CURATOR_WEEKLY_DEDUP_SETTING_KEY = "curator_weekly_last_week_key_v1";
const CURATOR_WEEKLY_TIME_ZONE = "America/Los_Angeles";

export interface CuratorServiceDeps {
  listSkills: () => SkillListItem[];
  archiveSkill: (skillId: string, reason: string, actorId?: string) => SkillListItem;
  pruneSkill: (skillId: string, actorId?: string) => { filesRemoved: string[] };
  now: () => Date;
  writeReport: (report: CuratorRunReport) => Promise<string>;
  publishRealtime: (topic: string, payload: Record<string, unknown>) => void;
  cycleDays: number;
  storage?: Pick<Storage, "cronJobs" | "systemSettings">; // NEW: optional, gates curator cron methods
}

export class CuratorService {
  public constructor(private readonly deps: CuratorServiceDeps) {}

  public listCuratorStatus(): CuratorStatusResponse {
    const now = this.deps.now();
    const items = this.deps
      .listSkills()
      .map((skill): CuratorSkillStatusItem => this.toStatusItem(skill, now))
      .sort((a, b) => b.usageCount - a.usageCount);
    return {
      generatedAt: now.toISOString(),
      cycleDays: this.deps.cycleDays,
      items,
    };
  }

  private toStatusItem(skill: SkillListItem, now: Date): CuratorSkillStatusItem {
    const immunity = computeSkillImmunity(skill);
    const grade = gradeSkillUsage({ skill, now });
    return {
      skillId: skill.skillId,
      name: skill.name,
      source: skill.source,
      pinned: skill.pinned ?? false,
      bundled: skill.source === "bundled",
      immune: immunity.immune,
      immunityReason: immunity.reason,
      state: skill.state,
      usageCount: skill.usageCount ?? 0,
      lastUsedAt: skill.lastUsedAt,
      ageDays: grade.ageDays,
      score: grade.score,
      signals: grade.signals,
      recommendation: immunity.immune ? "keep" : grade.recommendation,
      archived: skill.state === "disabled" && (skill.note?.startsWith("curator:archived") ?? false),
      archivedAt: undefined,
    };
  }

  public archive(input: CuratorArchiveRequest): CuratorArchiveResponse {
    if (input.confirm !== true) {
      throw new ValidationError({ message: "Curator: archive requires confirm: true" });
    }
    const skill = this.deps.listSkills().find((s) => s.skillId === input.skillId);
    if (!skill) {
      throw new Error(`Curator: skill not found: ${input.skillId}`);
    }
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      throw new Error(`Curator: ${immunity.reason} skill ${input.skillId} cannot be archived`);
    }
    const archiveReason = normalizeArchiveReason(input.reason);
    const updated = this.deps.archiveSkill(input.skillId, archiveReason, input.actorId);
    const archivedAt = this.deps.now().toISOString();
    this.deps.publishRealtime("curator", {
      type: "skill_archived",
      skillId: input.skillId,
      reason: archiveReason,
      archivedAt,
    });
    return {
      skillId: input.skillId,
      archived: true,
      archivedAt,
      state: updated.state,
    };
  }

  public prune(input: CuratorPruneRequest): CuratorPruneResponse {
    if (input.confirm !== true) {
      throw new Error("Curator: prune requires confirm: true");
    }
    const skill = this.deps.listSkills().find((s) => s.skillId === input.skillId);
    if (!skill) {
      throw new Error(`Curator: skill not found: ${input.skillId}`);
    }
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      throw new Error(`Curator: ${immunity.reason} skill ${input.skillId} cannot be pruned`);
    }
    const result = this.deps.pruneSkill(input.skillId, input.actorId);
    const prunedAt = this.deps.now().toISOString();
    this.deps.publishRealtime("curator", {
      type: "skill_pruned",
      skillId: input.skillId,
      prunedAt,
      filesRemoved: result.filesRemoved,
    });
    return {
      skillId: input.skillId,
      pruned: true,
      prunedAt,
      filesRemoved: result.filesRemoved,
    };
  }

  public listArchived(): CuratorListArchivedResponse {
    const now = this.deps.now();
    const items = this.deps
      .listSkills()
      .filter((skill) => skill.state === "disabled" && (skill.note?.startsWith("curator:archived") ?? false))
      .map((skill) => this.toStatusItem(skill, now));
    return {
      generatedAt: now.toISOString(),
      items,
    };
  }

  public async runCurator(input: CuratorRunRequest = {}): Promise<CuratorRunResponse> {
    const requestedDryRun = (input as { dryRun?: boolean }).dryRun;
    if (requestedDryRun === false) {
      throw new ValidationError({
        message: "Curator runs are proposal-only; use the confirmed curator archive endpoint to mutate skills.",
      });
    }
    const startedAt = this.deps.now();
    const runId = `curator-run-${randomUUID()}`;
    const dryRun = true;
    const skills = this.deps.listSkills();
    const entries: CuratorRunReportEntry[] = [];
    let immuneCount = 0;
    const archivedCount = 0;
    let proposalCount = 0;

    for (const skill of skills) {
      const immunity = computeSkillImmunity(skill);
      const grade = gradeSkillUsage({ skill, now: startedAt });
      if (immunity.immune) {
        immuneCount += 1;
        entries.push({
          skillId: skill.skillId,
          name: skill.name,
          recommendation: "keep",
          score: grade.score,
          signals: grade.signals,
          action: "skipped_immune",
          actionReason: immunity.reason,
        });
        continue;
      }
      if (grade.recommendation === "archive") {
        proposalCount += 1;
        entries.push({
          skillId: skill.skillId,
          name: skill.name,
          recommendation: grade.recommendation,
          score: grade.score,
          signals: grade.signals,
          action: "proposed_archive",
          actionReason: "rubric_below_threshold",
        });
      } else {
        entries.push({
          skillId: skill.skillId,
          name: skill.name,
          recommendation: grade.recommendation,
          score: grade.score,
          signals: grade.signals,
          action: "none",
        });
      }
    }

    const finishedAt = this.deps.now();
    const report: CuratorRunReport = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      triggerMode: input.triggerMode ?? (input.sync ? "synchronous" : "manual"),
      dryRun,
      cycleDays: this.deps.cycleDays,
      totalSkills: skills.length,
      immuneCount,
      scoredCount: entries.length,
      archivedCount,
      proposalCount,
      prunedCount: 0,
      consolidationGroupCount: 0,
      entries,
      reportDir: "",
    };
    report.reportDir = await this.deps.writeReport(report);
    this.deps.publishRealtime("curator", {
      type: "curator_run_completed",
      runId,
      archivedCount,
      proposalCount,
      immuneCount,
      totalSkills: skills.length,
      reportDir: report.reportDir,
    });
    return { runId, scheduled: false, report };
  }

  public ensureCuratorWeeklyCronJob(): void {
    if (!this.deps.storage) return;
    const existing = this.deps.storage.cronJobs.get(CURATOR_WEEKLY_JOB_ID);
    const now = this.deps.now().toISOString();
    this.deps.storage.cronJobs.upsertIfChanged(
      {
        jobId: CURATOR_WEEKLY_JOB_ID,
        name: "Curator Weekly Report",
        action: "curator",
        description: "Generate a proposal-only curator report over the skill registry.",
        schedule: CURATOR_WEEKLY_SCHEDULE_LABEL,
        enabled: existing?.enabled ?? true,
        endAt: existing?.endAt,
        lastRunAt: existing?.lastRunAt,
        nextRunAt: existing?.nextRunAt,
      },
      now,
    );
  }

  public async runCuratorWeeklyIfDue(options: { force?: boolean } = {}): Promise<void> {
    if (!this.deps.storage) return;
    const job = this.deps.storage.cronJobs.get(CURATOR_WEEKLY_JOB_ID);
    if (!job?.enabled) return;
    const now = this.deps.now();
    if (!options.force) {
      const parts = getZonedDateParts(now, CURATOR_WEEKLY_TIME_ZONE);
      // Sunday=0, 02:00 hour gate (matches improvement_weekly cadence)
      if (parts.weekday !== 0 || parts.hour !== 2) return;
    }
    const weekKey = toWeekKeyForTimezone(now, CURATOR_WEEKLY_TIME_ZONE);
    const lastWeekKey = this.deps.storage.systemSettings.get<string>(CURATOR_WEEKLY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && lastWeekKey === weekKey) return;
    await this.runCurator({ sync: false, dryRun: true, triggerMode: "scheduled" });
    this.deps.storage.systemSettings.set(CURATOR_WEEKLY_DEDUP_SETTING_KEY, weekKey);
    const finishedAt = this.deps.now().toISOString();
    this.deps.storage.cronJobs.upsert(
      {
        ...job,
        lastRunAt: finishedAt,
        // Note: force-runs set nextRunAt = now + 7d which drifts from the Sunday 02:00 PT schedule.
        // Normal scheduled runs naturally re-align since the time-of-week guard only fires on Sunday 02:00.
        nextRunAt: new Date(this.deps.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      finishedAt,
    );
  }

  public async executeDurableCuratorTickRun(run: DurableRunRecord, _context: unknown): Promise<void> {
    const payload = run.payload as
      | { version?: string; runId?: string; triggerMode?: string; cycleDays?: number; requestedAt?: string }
      | undefined;
    if (!payload || payload.version !== "curator.tick.v1") {
      throw new Error("curator.tick: invalid payload version");
    }
    if (typeof payload.runId !== "string" || payload.runId.length === 0) {
      throw new Error("curator.tick: invalid payload runId");
    }
    if (payload.triggerMode !== "scheduled" && payload.triggerMode !== "manual") {
      throw new Error("curator.tick: invalid payload triggerMode");
    }
    await this.runCurator({ sync: false, dryRun: true, triggerMode: "scheduled" });
  }
}

function normalizeArchiveReason(reason?: string): string {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return "curator:archived";
  }
  return trimmed.startsWith("curator:archived") ? trimmed : `curator:archived ${trimmed}`;
}
