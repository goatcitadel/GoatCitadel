import type {
  CuratorArchiveRequest,
  CuratorArchiveResponse,
  CuratorListArchivedResponse,
  CuratorPruneRequest,
  CuratorPruneResponse,
  CuratorRunReport,
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

  public archive(_input: CuratorArchiveRequest): CuratorArchiveResponse {
    throw new Error("not implemented yet");
  }

  public prune(_input: CuratorPruneRequest): CuratorPruneResponse {
    throw new Error("not implemented yet");
  }

  public listArchived(): CuratorListArchivedResponse {
    throw new Error("not implemented yet");
  }

  public async runCurator(_input: CuratorRunRequest): Promise<CuratorRunResponse> {
    throw new Error("not implemented yet");
  }
}
