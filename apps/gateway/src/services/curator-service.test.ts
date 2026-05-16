import { describe, it, expect, beforeEach } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
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
  it("archives a managed unpinned skill (calls archiveSkill once)", () => {
    let archivedId: string | undefined;
    const skills = [makeSkill({ name: "alpha", usageCount: 0 })];
    const service = new CuratorService({
      listSkills: () => skills,
      archiveSkill: (skillId) => {
        archivedId = skillId;
        return makeSkill({ name: "alpha", state: "disabled" });
      },
      pruneSkill: () => ({ filesRemoved: [] }),
      now: () => new Date("2026-05-15T12:00:00Z"),
      writeReport: async () => "/tmp/dummy",
      publishRealtime: () => undefined,
      cycleDays: 7,
    });
    const response = service.archive({ skillId: skills[0].skillId });
    expect(archivedId).toBe(skills[0].skillId);
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
    expect(() => service.archive({ skillId: skills[0].skillId })).toThrow(/pinned/i);
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
    expect(() => service.archive({ skillId: skills[0].skillId })).toThrow(/bundled/i);
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
    expect(() => service.archive({ skillId: "skill-missing" })).toThrow(/not found/i);
  });
});
