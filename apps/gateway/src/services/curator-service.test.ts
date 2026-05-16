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
