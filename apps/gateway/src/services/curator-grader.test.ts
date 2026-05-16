import { describe, it, expect } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { computeSkillImmunity } from "./curator-grader.js";

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
