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
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { CronSpecMutationOwner } from "./cron-config-generation-owner.js";
import { computeSkillImmunity, gradeSkillUsage } from "./curator-grader.js";
import { planCuratorIdleSweep, type CuratorIdleSweepResult, type CuratorIdleSweepDeps } from "./curator-idle-sweep.js";
import { getZonedDateParts, toWeekKeyForTimezone } from "./improvement-replay.js";

const CURATOR_WEEKLY_JOB_ID = "curator_weekly";
const CURATOR_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const CURATOR_WEEKLY_DEDUP_SETTING_KEY = "curator_weekly_last_week_key_v1";
const CURATOR_WEEKLY_TIME_ZONE = "America/Los_Angeles";

/** Dedup/cadence key for the S3 idle sweep (last successful sweep epoch ms). */
const CURATOR_IDLE_SWEEP_LAST_RUN_SETTING_KEY = "curator_idle_sweep_last_run_ms_v1";
/** Minimum interval between idle sweeps, ms (defaults to {@link CuratorServiceDeps.cycleDays}). */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Collaborators the S3 idle janitor needs beyond the proposal-only weekly run:
 * an idle signal, the master autonomy switch, and a reversible snapshot hook.
 * Optional — when absent, {@link CuratorService.maybeRunIdleCurator} is a no-op
 * so existing constructions keep byte-identical behavior.
 */
export interface CuratorIdleSweepCollaborators {
  /**
   * True when the workspace is idle (no active turns). Mirrors the maintenance
   * scheduler's idle posture (e.g. heartbeat's "no running turn") so the janitor
   * never runs while the user is mid-turn.
   */
  isWorkspaceIdle: () => boolean;
  /**
   * Master autonomy switch (`!isFeatureEnabled("autonomyV1Disabled")`). When
   * false the sweep is proposal-only: it computes archives/merges but applies
   * nothing.
   */
  isAutonomyEnabled: () => Promise<boolean>;
  /**
   * Capture a reversible snapshot of a skill BEFORE it is archived. Invoked only
   * under full autonomy, immediately before the archive disable. Archive itself
   * stays disable-only (never hard-delete); restore re-enables from the snapshot.
   */
  snapshotSkill: (skillId: string) => Promise<void> | void;
  /** Optional near-dup similarity override (defaults to name/title overlap). */
  similarity?: CuratorIdleSweepDeps["similarity"];
}

export interface CuratorServiceDeps {
  listSkills: () => Promise<SkillListItem[]>;
  archiveSkill: (skillId: string, reason: string, actorId?: string) => Promise<SkillListItem>;
  pruneSkill: (skillId: string, actorId?: string) => Promise<{ filesRemoved: string[] }>;
  now: () => Date;
  writeReport: (report: CuratorRunReport) => Promise<string>;
  publishRealtime: (topic: string, payload: Record<string, unknown>) => Promise<unknown>;
  cycleDays: number;
  storage?: Pick<Storage, "cronJobs" | "systemSettings">; // NEW: optional, gates curator cron methods
  cronSpecOwner?: Pick<CronSpecMutationOwner, "reconcileSpec">;
  idleSweep?: CuratorIdleSweepCollaborators; // NEW (S3): optional, gates the idle janitor
}

export class CuratorService {
  public constructor(private readonly deps: CuratorServiceDeps) {}

  public async listCuratorStatus(): Promise<CuratorStatusResponse> {
    const now = this.deps.now();
    const items = (await this.deps.listSkills())
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

  public async archive(input: CuratorArchiveRequest): Promise<CuratorArchiveResponse> {
    if (input.confirm !== true) {
      throw new ValidationError({ message: "Curator: archive requires confirm: true" });
    }
    const skill = (await this.deps.listSkills()).find((s) => s.skillId === input.skillId);
    if (!skill) {
      throw new Error(`Curator: skill not found: ${input.skillId}`);
    }
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      throw new Error(`Curator: ${immunity.reason} skill ${input.skillId} cannot be archived`);
    }
    const archiveReason = normalizeArchiveReason(input.reason);
    const updated = await this.deps.archiveSkill(input.skillId, archiveReason, input.actorId);
    const archivedAt = this.deps.now().toISOString();
    await this.deps.publishRealtime("curator", {
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

  public async prune(input: CuratorPruneRequest): Promise<CuratorPruneResponse> {
    if (input.confirm !== true) {
      throw new Error("Curator: prune requires confirm: true");
    }
    const skill = (await this.deps.listSkills()).find((s) => s.skillId === input.skillId);
    if (!skill) {
      throw new Error(`Curator: skill not found: ${input.skillId}`);
    }
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      throw new Error(`Curator: ${immunity.reason} skill ${input.skillId} cannot be pruned`);
    }
    const result = await this.deps.pruneSkill(input.skillId, input.actorId);
    const prunedAt = this.deps.now().toISOString();
    await this.deps.publishRealtime("curator", {
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

  public async listArchived(): Promise<CuratorListArchivedResponse> {
    const now = this.deps.now();
    const items = (await this.deps.listSkills())
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
    const skills = await this.deps.listSkills();
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
    await this.deps.publishRealtime("curator", {
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

  public async ensureCuratorWeeklyCronJob(): Promise<void> {
    if (!this.deps.storage) return;
    if (!this.deps.cronSpecOwner) {
      throw new Error("Cron spec owner is required to reconcile the weekly curator job.");
    }
    const existing = await this.deps.storage.cronJobs.get(CURATOR_WEEKLY_JOB_ID);
    await this.deps.cronSpecOwner.reconcileSpec({
      jobId: CURATOR_WEEKLY_JOB_ID,
      name: "Curator Weekly Report",
      action: "curator",
      description: "Generate a proposal-only curator report over the skill registry.",
      schedule: CURATOR_WEEKLY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      endAt: existing?.endAt,
    });
  }

  public async runCuratorWeeklyIfDue(options: { force?: boolean; recordCronState?: boolean } = {}): Promise<void> {
    if (!this.deps.storage) return;
    const job = await this.deps.storage.cronJobs.get(CURATOR_WEEKLY_JOB_ID);
    if (!job?.enabled) return;
    const now = this.deps.now();
    if (!options.force) {
      const parts = getZonedDateParts(now, CURATOR_WEEKLY_TIME_ZONE);
      // Sunday=0, 02:00 hour gate (matches improvement_weekly cadence)
      if (parts.weekday !== 0 || parts.hour !== 2) return;
    }
    const weekKey = toWeekKeyForTimezone(now, CURATOR_WEEKLY_TIME_ZONE);
    const lastWeekKey = (await this.deps.storage.systemSettings.get<string>(CURATOR_WEEKLY_DEDUP_SETTING_KEY))?.value;
    if (!options.force && lastWeekKey === weekKey) return;
    await this.runCurator({ sync: false, dryRun: true, triggerMode: "scheduled" });
    await this.deps.storage.systemSettings.set(CURATOR_WEEKLY_DEDUP_SETTING_KEY, weekKey);
    const finishedAt = this.deps.now().toISOString();
    if (options.recordCronState !== false) {
      await this.deps.storage.cronJobs.mergeRuntimeTelemetry(
        job.jobId,
        {
          lastRunAt: finishedAt,
          // Note: force-runs set nextRunAt = now + 7d which drifts from the Sunday 02:00 PT schedule.
          // Normal scheduled runs naturally re-align since the time-of-week guard only fires on Sunday 02:00.
          nextRunAt: new Date(this.deps.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        finishedAt,
      );
    }
  }

  /**
   * S3 — idle janitor entry point for the maintenance tick. Bounded by:
   *  1. idle-sweep collaborators being wired (no-op otherwise),
   *  2. the workspace being idle (no active turns) — never runs mid-turn,
   *  3. the curator cadence (`cycleDays`) since the last successful sweep.
   *
   * When all gates pass it runs {@link runCuratorIdleSweep}. Best-effort: this
   * method never throws — a failure is swallowed (and surfaced via realtime) so
   * it can be dropped straight into the maintenance tick like the F3/F4 sweeps.
   * The cadence cursor only advances after a clean run, so a transient failure
   * is retried on the next eligible tick.
   */
  public async maybeRunIdleCurator(options: { force?: boolean } = {}): Promise<CuratorIdleSweepResult | undefined> {
    const idle = this.deps.idleSweep;
    if (!idle) {
      return undefined;
    }
    try {
      if (!options.force && !idle.isWorkspaceIdle()) {
        return undefined;
      }
      if (!options.force && !(await this.isIdleSweepCadenceDue())) {
        return undefined;
      }
      const result = await this.runCuratorIdleSweep();
      await this.recordIdleSweepRun();
      return result;
    } catch (error) {
      // Best-effort: a janitor failure must never crash the maintenance tick.
      await this.deps.publishRealtime("curator", {
        type: "curator_idle_sweep_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Run a single idle sweep over `category:"self_generated"` skills NOW, ignoring
   * the idle/cadence gates (those live in {@link maybeRunIdleCurator}). Applies
   * the existing deterministic stale/archive transitions + near-duplicate merges,
   * scoped to agent-created skills; `pinned` / built-in / bundled skills are
   * exempt. Under full autonomy archives/merges auto-apply (snapshotted, archive
   * = disable, never hard-delete); otherwise they are proposals only.
   */
  public async runCuratorIdleSweep(): Promise<CuratorIdleSweepResult> {
    const idle = this.deps.idleSweep;
    if (!idle) {
      throw new Error("Curator: idle sweep collaborators are not configured");
    }
    const autoApply = await idle.isAutonomyEnabled();
    const result = await planCuratorIdleSweep({
      listSkills: async () => await this.deps.listSkills(),
      now: () => this.deps.now(),
      runId: `curator-idle-${randomUUID()}`,
      autoApply,
      snapshotSkill: (skillId) => idle.snapshotSkill(skillId),
      archiveSkill: async (skillId, reason) => {
        await this.deps.archiveSkill(skillId, reason);
      },
      similarity: idle.similarity,
    });
    await this.deps.publishRealtime("curator", {
      type: "curator_idle_sweep_completed",
      runId: result.runId,
      autoApplied: result.autoApplied,
      scannedSelfGenerated: result.scannedSelfGenerated,
      immuneCount: result.immuneCount,
      archivedCount: result.archives.filter((entry) => entry.applied).length,
      archiveProposalCount: result.archives.filter((entry) => !entry.applied).length,
      mergeCount: result.merges.length,
    });
    return result;
  }

  /** Whether the idle sweep cadence (`cycleDays`) has elapsed since the last run. */
  private async isIdleSweepCadenceDue(): Promise<boolean> {
    if (!this.deps.storage) {
      // No settings store ⇒ cannot dedup; allow the sweep (idle gate still applies).
      return true;
    }
    const lastRunMs = (await this.deps.storage.systemSettings.get<number>(CURATOR_IDLE_SWEEP_LAST_RUN_SETTING_KEY))
      ?.value;
    if (typeof lastRunMs !== "number" || !Number.isFinite(lastRunMs)) {
      return true;
    }
    const intervalMs = Math.max(1, this.deps.cycleDays) * DAY_MS;
    return this.deps.now().getTime() - lastRunMs >= intervalMs;
  }

  /** Advance the idle sweep cadence cursor after a clean run. */
  private async recordIdleSweepRun(): Promise<void> {
    if (!this.deps.storage) {
      return;
    }
    await this.deps.storage.systemSettings.set(CURATOR_IDLE_SWEEP_LAST_RUN_SETTING_KEY, this.deps.now().getTime());
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
