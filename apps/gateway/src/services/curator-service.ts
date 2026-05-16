import { randomUUID } from "node:crypto";
import type {
  CuratorArchiveRequest,
  CuratorArchiveResponse,
  CuratorListArchivedResponse,
  CuratorPruneRequest,
  CuratorPruneResponse,
  CuratorRunReport,
  CuratorRunReportEntry,
  CuratorRunRequest,
  CuratorRunResponse,
  CuratorSkillStatusItem,
  CuratorStatusResponse,
  SkillListItem,
} from "@goatcitadel/contracts";
import { computeSkillImmunity, gradeSkillUsage } from "./curator-grader.js";

export interface CuratorServiceDeps {
  listSkills: () => SkillListItem[];
  archiveSkill: (skillId: string, reason: string, actorId?: string) => SkillListItem;
  pruneSkill: (skillId: string, actorId?: string) => { filesRemoved: string[] };
  now: () => Date;
  writeReport: (report: CuratorRunReport) => Promise<string>;
  publishRealtime: (topic: string, payload: Record<string, unknown>) => void;
  cycleDays: number;
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
    const skill = this.deps.listSkills().find((s) => s.skillId === input.skillId);
    if (!skill) {
      throw new Error(`Curator: skill not found: ${input.skillId}`);
    }
    const immunity = computeSkillImmunity(skill);
    if (immunity.immune) {
      throw new Error(`Curator: ${immunity.reason} skill ${input.skillId} cannot be archived`);
    }
    const updated = this.deps.archiveSkill(input.skillId, input.reason ?? "curator:archived", input.actorId);
    const archivedAt = this.deps.now().toISOString();
    this.deps.publishRealtime("curator", {
      type: "skill_archived",
      skillId: input.skillId,
      reason: input.reason ?? "curator:archived",
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

  public async runCurator(input: CuratorRunRequest): Promise<CuratorRunResponse> {
    const startedAt = this.deps.now();
    const runId = `curator-run-${randomUUID()}`;
    const dryRun = Boolean(input.dryRun);
    const skills = this.deps.listSkills();
    const entries: CuratorRunReportEntry[] = [];
    let immuneCount = 0;
    let archivedCount = 0;

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
      if (grade.recommendation === "archive" && !dryRun) {
        try {
          this.deps.archiveSkill(skill.skillId, "curator:archived rubric_below_threshold", input.actorId);
          archivedCount += 1;
          entries.push({
            skillId: skill.skillId,
            name: skill.name,
            recommendation: grade.recommendation,
            score: grade.score,
            signals: grade.signals,
            action: "archived",
            actionReason: "rubric_below_threshold",
          });
        } catch (error) {
          entries.push({
            skillId: skill.skillId,
            name: skill.name,
            recommendation: grade.recommendation,
            score: grade.score,
            signals: grade.signals,
            action: "skipped_below_threshold",
            actionReason: (error as Error).message,
          });
        }
      } else {
        entries.push({
          skillId: skill.skillId,
          name: skill.name,
          recommendation: grade.recommendation,
          score: grade.score,
          signals: grade.signals,
          action: grade.recommendation === "archive" ? "skipped_below_threshold" : "none",
        });
      }
    }

    const finishedAt = this.deps.now();
    const report: CuratorRunReport = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      triggerMode: input.sync ? "synchronous" : "manual",
      dryRun,
      cycleDays: this.deps.cycleDays,
      totalSkills: skills.length,
      immuneCount,
      scoredCount: entries.length,
      archivedCount,
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
      immuneCount,
      totalSkills: skills.length,
      reportDir: report.reportDir,
    });
    return { runId, scheduled: false, report };
  }
}
