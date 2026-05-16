import { describe, it, expect } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { computeSkillImmunity, gradeSkillUsage } from "./curator-grader.js";

function makeSkill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skillId: "skill-test",
    name: "test",
    source: "managed",
    dir: "/tmp/skills/test",
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

describe("computeSkillImmunity", () => {
  it("marks bundled skills immune with reason 'bundled'", () => {
    const result = computeSkillImmunity(makeSkill({ source: "bundled" }));
    expect(result).toEqual({ immune: true, reason: "bundled" });
  });

  it("marks pinned skills immune with reason 'pinned'", () => {
    const result = computeSkillImmunity(makeSkill({ source: "managed", pinned: true }));
    expect(result).toEqual({ immune: true, reason: "pinned" });
  });

  it("treats pinned bundled skills as bundled-immune (bundled wins)", () => {
    const result = computeSkillImmunity(makeSkill({ source: "bundled", pinned: true }));
    expect(result).toEqual({ immune: true, reason: "bundled" });
  });

  it("returns immune=false for ordinary managed skills", () => {
    const result = computeSkillImmunity(makeSkill({ source: "managed", pinned: false }));
    expect(result).toEqual({ immune: false });
  });

  it("returns immune=false for workspace and extra skills when not pinned", () => {
    expect(computeSkillImmunity(makeSkill({ source: "workspace" }))).toEqual({ immune: false });
    expect(computeSkillImmunity(makeSkill({ source: "extra" }))).toEqual({ immune: false });
  });
});

describe("gradeSkillUsage", () => {
  it("returns all-low score with recommendation 'archive' for unused skills", () => {
    const grade = gradeSkillUsage({
      skill: makeSkill({ usageCount: 0, lastUsedAt: undefined }),
      now: new Date("2026-05-15T00:00:00Z"),
    });
    expect(grade.score.mean).toBeLessThan(0.5);
    expect(grade.recommendation).toBe("archive");
    expect(grade.signals).toContain("never_used");
  });

  it("returns 'keep' for high-usage recent skills", () => {
    const grade = gradeSkillUsage({
      skill: makeSkill({ usageCount: 80, lastUsedAt: "2026-05-14T00:00:00Z" }),
      now: new Date("2026-05-15T00:00:00Z"),
    });
    expect(grade.score.mean).toBeGreaterThan(0.6);
    expect(grade.recommendation).toBe("keep");
  });

  it("ages skills: lastUsedAt 100 days ago becomes archive candidate", () => {
    const grade = gradeSkillUsage({
      skill: makeSkill({ usageCount: 2, lastUsedAt: "2026-02-04T00:00:00Z" }),
      now: new Date("2026-05-15T00:00:00Z"),
    });
    expect(grade.recommendation).toBe("archive");
    expect(grade.signals).toContain("stale_usage");
  });

  it("returns numeric class-first scores, not free-form text", () => {
    const grade = gradeSkillUsage({
      skill: makeSkill({ usageCount: 5, lastUsedAt: "2026-05-10T00:00:00Z" }),
      now: new Date("2026-05-15T00:00:00Z"),
    });
    expect(typeof grade.score.honesty).toBe("number");
    expect(typeof grade.score.blockerQuality).toBe("number");
    expect(typeof grade.score.retryQuality).toBe("number");
    expect(typeof grade.score.toolEvidence).toBe("number");
    expect(typeof grade.score.actionability).toBe("number");
    for (const value of Object.values(grade.score)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
