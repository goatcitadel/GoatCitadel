import { describe, it, expect, beforeEach } from "vitest";
import type { CuratorRunReport, DurableRunRecord, SkillListItem } from "@goatcitadel/contracts";
import { CuratorService } from "./curator-service.js";

function makeSkill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skillId: `skill-${overrides.name ?? "x"}`,
    name: String(overrides.name ?? "x"),
    source: "managed",
    dir: `/tmp/skills/${overrides.name ?? "x"}`,
    declaredTools: [],
    requires: [],
    keywords: [],
    instructionBody: "",
    mtime: new Date().toISOString(),
    state: "enabled",
    pinned: false,
    ...overrides,
  } as SkillListItem;
}

describe("CuratorService.listCuratorStatus", () => {
  let skills: SkillListItem[];
  let service: CuratorService;

  beforeEach(() => {
    skills = [
      makeSkill({ name: "alpha", usageCount: 30, lastUsedAt: "2026-05-14T00:00:00Z" }),
      makeSkill({ name: "beta", usageCount: 0, lastUsedAt: undefined }),
      makeSkill({ name: "gamma", usageCount: 90, lastUsedAt: "2026-05-15T00:00:00Z" }),
      makeSkill({ name: "delta", source: "bundled", usageCount: 5 }),
    ];
    service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => {
        throw new Error("archive should not be called in status");
      },
      pruneSkill: () => {
        throw new Error("prune should not be called in status");
      },
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
  });

  it("ranks skills by usage count descending (most-used first)", () => {
    const response = service.listCuratorStatus();
    const names = response.items.map((item) => item.name);
    expect(names).toEqual(["gamma", "alpha", "delta", "beta"]);
  });

  it("marks bundled skills immune", () => {
    const response = service.listCuratorStatus();
    const delta = response.items.find((i) => i.name === "delta");
    expect(delta?.immune).toBe(true);
    expect(delta?.immunityReason).toBe("bundled");
  });

  it("recommends 'archive' for unused skills", () => {
    const response = service.listCuratorStatus();
    const beta = response.items.find((i) => i.name === "beta");
    expect(beta?.recommendation).toBe("archive");
  });
});

describe("CuratorService.archive", () => {
  it("requires confirm: true to archive", () => {
    const skills = [makeSkill({ name: "alpha", usageCount: 0 })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => {
        throw new Error("archive should not be called without confirm");
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.archive({ skillId: skills[0].skillId, confirm: false as unknown as true })).toThrow(
      /confirm/i,
    );
  });

  it("archives a managed unpinned skill (calls archiveSkill once)", () => {
    let archivedId: string | undefined;
    let archiveReason: string | undefined;
    const skills = [makeSkill({ name: "alpha", usageCount: 0 })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId, reason) => {
        archivedId = skillId;
        archiveReason = reason;
        return makeSkill({ name: "alpha", state: "disabled" });
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = service.archive({ skillId: skills[0].skillId, confirm: true, reason: "manual operator archive" });
    expect(archivedId).toBe(skills[0].skillId);
    expect(archiveReason).toBe("curator:archived manual operator archive");
    expect(response.archived).toBe(true);
    expect(response.state).toBe("disabled");
  });

  it("refuses to archive a pinned skill", () => {
    const skills = [makeSkill({ name: "alpha", pinned: true })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => {
        throw new Error("archive should not be called for pinned skills");
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.archive({ skillId: skills[0].skillId, confirm: true })).toThrow(/pinned/i);
  });

  it("refuses to archive a bundled skill", () => {
    const skills = [makeSkill({ name: "alpha", source: "bundled" })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => {
        throw new Error("archive should not be called for bundled skills");
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.archive({ skillId: skills[0].skillId, confirm: true })).toThrow(/bundled/i);
  });

  it("throws NotFoundError for unknown skill ids", () => {
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => {
        throw new Error("not called");
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.archive({ skillId: "skill-missing", confirm: true })).toThrow(/not found/i);
  });
});

describe("CuratorService.prune", () => {
  it("requires confirm: true to actually prune", () => {
    const skills = [makeSkill({ name: "alpha", state: "disabled" })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0],
      pruneSkill: () => {
        throw new Error("prune should not be called without confirm");
      },
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.prune({ skillId: skills[0].skillId, confirm: false as unknown as true })).toThrow(/confirm/i);
  });

  it("prunes a managed, archived, unpinned, non-bundled skill", () => {
    const skills = [makeSkill({ name: "alpha", state: "disabled" })];
    let prunedId: string | undefined;
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0],
      pruneSkill: (skillId) => {
        prunedId = skillId;
        return { filesRemoved: ["/tmp/skills/alpha/SKILL.md"] };
      },
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = service.prune({ skillId: skills[0].skillId, confirm: true });
    expect(prunedId).toBe(skills[0].skillId);
    expect(response.pruned).toBe(true);
    expect(response.filesRemoved).toContain("/tmp/skills/alpha/SKILL.md");
  });

  it("refuses to prune a pinned skill", () => {
    const skills = [makeSkill({ name: "alpha", pinned: true })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0],
      pruneSkill: () => {
        throw new Error("prune should not be called for pinned skills");
      },
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.prune({ skillId: skills[0].skillId, confirm: true })).toThrow(/pinned/i);
  });

  it("refuses to prune a bundled skill", () => {
    const skills = [makeSkill({ name: "alpha", source: "bundled" })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0],
      pruneSkill: () => {
        throw new Error("prune should not be called for bundled skills");
      },
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    expect(() => service.prune({ skillId: skills[0].skillId, confirm: true })).toThrow(/bundled/i);
  });
});

describe("CuratorService.listArchived", () => {
  it("returns only skills with curator:archived note marker", () => {
    const skills: SkillListItem[] = [
      makeSkill({ name: "alpha", state: "enabled" }) as SkillListItem,
      {
        ...(makeSkill({ name: "beta", state: "disabled" }) as SkillListItem),
        note: "curator:archived rubric_below_threshold",
      },
      { ...(makeSkill({ name: "gamma", state: "disabled" }) as SkillListItem), note: "manual disable" },
    ];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0],
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = service.listArchived();
    expect(response.items.map((i) => i.name)).toEqual(["beta"]);
    expect(response.items[0].archived).toBe(true);
  });
});

describe("CuratorService.runCurator", () => {
  it("scores every skill, proposes below-threshold archives, writes report, and never mutates", async () => {
    const archived: string[] = [];
    const reports: CuratorRunReport[] = [];
    const skills: SkillListItem[] = [
      makeSkill({ name: "alpha", usageCount: 0 }) as SkillListItem,
      makeSkill({ name: "beta", source: "bundled", usageCount: 0 }) as SkillListItem,
      makeSkill({ name: "gamma", pinned: true, usageCount: 0 }) as SkillListItem,
      makeSkill({ name: "delta", usageCount: 100, lastUsedAt: "2026-05-15T00:00:00Z" }) as SkillListItem,
    ];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId) => {
        archived.push(skillId);
        const skill = skills.find((s) => s.skillId === skillId)!;
        return { ...skill, state: "disabled" };
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async (report) => {
        reports.push(report);
        return `/tmp/logs/curator/${report.runId}`;
      },
      publishRealtime: () => undefined,
      cycleDays: 7,
    });

    const response = await service.runCurator({ sync: true });
    expect(response.runId).toMatch(/^curator-run-/);
    expect(response.scheduled).toBe(false);
    expect(response.report).toBeDefined();
    expect(response.report!.totalSkills).toBe(4);
    expect(response.report!.immuneCount).toBe(2);
    expect(response.report!.archivedCount).toBe(0);
    expect(response.report!.proposalCount).toBe(1);
    expect(response.report!.dryRun).toBe(true);
    expect(response.report!.entries.find((entry) => entry.skillId === "skill-alpha")?.action).toBe("proposed_archive");
    expect(archived).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it("does not archive on dryRun: true and emits archive proposals", async () => {
    const archived: string[] = [];
    const skills: SkillListItem[] = [makeSkill({ name: "alpha", usageCount: 0 }) as SkillListItem];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId) => {
        archived.push(skillId);
        return { ...skills[0], state: "disabled" };
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = await service.runCurator({ sync: true, dryRun: true });
    expect(archived).toEqual([]);
    expect(response.report!.archivedCount).toBe(0);
    expect(response.report!.proposalCount).toBe(1);
    expect(response.report!.entries[0].action).toBe("proposed_archive");
  });

  it("rejects dryRun: false before scoring or mutating", async () => {
    let listed = false;
    const service = new CuratorService({
      listSkills: () => {
        listed = true;
        return [makeSkill({ name: "alpha", usageCount: 0 }) as SkillListItem];
      },
      archiveSkill: () => {
        throw new Error("archive should not be called by runCurator");
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await expect(service.runCurator({ sync: true, dryRun: false as never })).rejects.toThrow(/proposal-only/i);
    expect(listed).toBe(false);
  });

  it("never archives bundled or pinned skills even when score is low", async () => {
    const archived: string[] = [];
    const skills: SkillListItem[] = [
      makeSkill({ name: "alpha", source: "bundled", usageCount: 0 }) as SkillListItem,
      makeSkill({ name: "beta", pinned: true, usageCount: 0 }) as SkillListItem,
    ];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId) => {
        archived.push(skillId);
        return { ...skills[0], state: "disabled" };
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = await service.runCurator({ sync: true });
    expect(archived).toEqual([]);
    expect(response.report!.entries.every((e) => e.action === "skipped_immune")).toBe(true);
  });

  it("uses triggerMode='scheduled' when called from cron tick and does not mutate", async () => {
    const reports: CuratorRunReport[] = [];
    const archived: string[] = [];
    const skills: SkillListItem[] = [makeSkill({ name: "alpha", usageCount: 0 }) as SkillListItem];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId) => {
        archived.push(skillId);
        return { ...skills[0], state: "disabled" };
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async (report) => {
        reports.push(report);
        return "/tmp/dummy";
      },
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await service.runCurator({ sync: false, dryRun: true, triggerMode: "scheduled" });
    expect(reports).toHaveLength(1);
    expect(reports[0].triggerMode).toBe("scheduled");
    expect(reports[0].proposalCount).toBe(1);
    expect(archived).toEqual([]);
  });

  it("uses triggerMode='manual' when no override is provided", async () => {
    const reports: CuratorRunReport[] = [];
    const skills: SkillListItem[] = [makeSkill({ name: "alpha", usageCount: 5 }) as SkillListItem];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: () => skills[0] as SkillListItem,
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async (report) => {
        reports.push(report);
        return "/tmp/dummy";
      },
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await service.runCurator({ sync: false });
    expect(reports[0].triggerMode).toBe("manual");
  });
});

describe("CuratorService cron scheduler", () => {
  type CronJob = {
    jobId: string;
    name: string;
    action: string;
    schedule: string;
    enabled: boolean;
    description?: string;
    lastRunAt?: string;
    nextRunAt?: string;
    endAt?: string;
  };
  type CronStore = Map<string, CronJob>;

  function makeStorageStub(): {
    cronJobs: {
      get: (id: string) => CronJob | undefined;
      upsert: (job: CronJob, finishedAt: string) => void;
      upsertIfChanged: (job: CronJob, now: string) => void;
    };
    systemSettings: {
      get: <T>(key: string) => { value: T } | undefined;
      set: <T>(key: string, value: T) => void;
    };
    crons: CronStore;
    settings: Map<string, unknown>;
  } {
    const crons: CronStore = new Map();
    const settings = new Map<string, unknown>();
    return {
      cronJobs: {
        get: (id: string) => crons.get(id),
        upsert: (job, _finishedAt) => {
          crons.set(job.jobId, { ...job });
        },
        upsertIfChanged: (job, _now) => {
          crons.set(job.jobId, { ...job });
        },
      },
      systemSettings: {
        get: <T>(key: string) => {
          const v = settings.get(key);
          return v === undefined ? undefined : { value: v as T };
        },
        set: <T>(key: string, value: T) => {
          settings.set(key, value);
        },
      },
      crons,
      settings,
    };
  }

  it("ensureCuratorWeeklyCronJob registers the cron with action=curator and Sunday 02:00 PT schedule", () => {
    const storageStub = makeStorageStub();
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
      storage: storageStub as never,
    });
    service.ensureCuratorWeeklyCronJob();
    const job = storageStub.crons.get("curator_weekly");
    expect(job).toBeDefined();
    expect(job?.action).toBe("curator");
    expect(job?.name).toBe("Curator Weekly Report");
    expect(job?.description).toBe("Generate a proposal-only curator report over the skill registry.");
    expect(job?.enabled).toBe(true);
    expect(job?.schedule).toBe("0 2 * * 0 America/Los_Angeles");
  });

  it("runCuratorWeeklyIfDue no-ops when cron job is missing or disabled", async () => {
    const storageStub = makeStorageStub();
    let runCalls = 0;
    const service = new CuratorService({
      listSkills: () => {
        runCalls += 1;
        return [];
      }, // listSkills called during run
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-17T02:00:00-07:00"), // Sunday 2am PT
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
      storage: storageStub as never,
    });
    // job not registered yet — should no-op
    await service.runCuratorWeeklyIfDue();
    expect(runCalls).toBe(0);

    // register but disabled — should no-op
    storageStub.crons.set("curator_weekly", {
      jobId: "curator_weekly",
      name: "x",
      action: "curator",
      schedule: "0 2 * * 0 America/Los_Angeles",
      enabled: false,
    });
    await service.runCuratorWeeklyIfDue();
    expect(runCalls).toBe(0);
  });

  it("runCuratorWeeklyIfDue with force=true bypasses time-of-week check + dedup", async () => {
    const storageStub = makeStorageStub();
    storageStub.crons.set("curator_weekly", {
      jobId: "curator_weekly",
      name: "x",
      action: "curator",
      schedule: "0 2 * * 0 America/Los_Angeles",
      enabled: true,
    });
    let runCalls = 0;
    const archived: string[] = [];
    const reports: CuratorRunReport[] = [];
    const service = new CuratorService({
      listSkills: () => {
        runCalls += 1;
        return [makeSkill({ name: "alpha", usageCount: 0 })];
      },
      archiveSkill: (skillId) => {
        archived.push(skillId);
        return makeSkill({ name: "alpha", state: "disabled" });
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"), // Wednesday, NOT due
      writeReport: async (report) => {
        reports.push(report);
        return "/tmp/dummy";
      },
      publishRealtime: () => undefined,
      cycleDays: 7,
      storage: storageStub as never,
    });
    await service.runCuratorWeeklyIfDue({ force: true });
    expect(runCalls).toBe(1);
    expect(archived).toEqual([]);
    expect(reports[0]).toMatchObject({ triggerMode: "scheduled", dryRun: true, proposalCount: 1, archivedCount: 0 });
    expect(storageStub.crons.get("curator_weekly")?.lastRunAt).toBeDefined();
  });

  it("runCuratorWeeklyIfDue is idempotent within a week (dedup via week key)", async () => {
    const storageStub = makeStorageStub();
    storageStub.crons.set("curator_weekly", {
      jobId: "curator_weekly",
      name: "x",
      action: "curator",
      schedule: "0 2 * * 0 America/Los_Angeles",
      enabled: true,
    });
    let runCalls = 0;
    const service = new CuratorService({
      listSkills: () => {
        runCalls += 1;
        return [];
      },
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
      storage: storageStub as never,
    });
    await service.runCuratorWeeklyIfDue({ force: true });
    await service.runCuratorWeeklyIfDue({ force: false }); // second call without force — should dedup since same week
    expect(runCalls).toBe(1);
  });

  it("when storage is undefined (constructor without storage), both cron methods are no-ops", async () => {
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    // No throw, no error
    service.ensureCuratorWeeklyCronJob();
    await service.runCuratorWeeklyIfDue();
    await service.runCuratorWeeklyIfDue({ force: true });
  });
});

describe("CuratorService.executeDurableCuratorTickRun", () => {
  function makeRun(payload: Record<string, unknown>): DurableRunRecord {
    return {
      runId: "durable-run-x",
      workflowKey: "curator.tick",
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload,
      createdAt: "2026-05-15T12:00:00Z",
      updatedAt: "2026-05-15T12:00:00Z",
    } as DurableRunRecord;
  }

  it("runs curator when payload is valid", async () => {
    let ran = false;
    const archived: string[] = [];
    const reports: CuratorRunReport[] = [];
    const skills = [makeSkill({ name: "alpha", usageCount: 0 })];
    const service = new CuratorService({
      listSkills: () => {
        ran = true;
        return skills;
      },
      archiveSkill: (skillId) => {
        archived.push(skillId);
        return makeSkill({ name: "alpha", state: "disabled" });
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async (report) => {
        reports.push(report);
        return "/tmp/dummy";
      },
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await service.executeDurableCuratorTickRun(
      makeRun({
        version: "curator.tick.v1",
        runId: "curator-run-xyz",
        triggerMode: "scheduled",
        cycleDays: 7,
        requestedAt: "2026-05-15T12:00:00Z",
      }),
      undefined,
    );
    expect(ran).toBe(true);
    expect(archived).toEqual([]);
    expect(reports[0]).toMatchObject({ triggerMode: "scheduled", dryRun: true, proposalCount: 1, archivedCount: 0 });
  });

  it("throws on invalid version", async () => {
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await expect(service.executeDurableCuratorTickRun(makeRun({ version: "wrong.v1" }), undefined)).rejects.toThrow(
      /version/i,
    );
  });

  it("throws on missing runId", async () => {
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await expect(
      service.executeDurableCuratorTickRun(makeRun({ version: "curator.tick.v1" }), undefined),
    ).rejects.toThrow(/runId/i);
  });

  it("throws on invalid triggerMode", async () => {
    const service = new CuratorService({
      listSkills: () => [],
      archiveSkill: () => makeSkill(),
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date(),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    await expect(
      service.executeDurableCuratorTickRun(
        makeRun({
          version: "curator.tick.v1",
          runId: "x",
          triggerMode: "bogus",
        }),
        undefined,
      ),
    ).rejects.toThrow(/triggerMode/i);
  });
});
