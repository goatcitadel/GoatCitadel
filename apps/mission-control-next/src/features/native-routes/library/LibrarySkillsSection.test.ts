import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { filterSkillList } from "./LibrarySkillsSection";

function skill(overrides: Partial<SkillListItem>): SkillListItem {
  return {
    skillId: "skill-a",
    name: "Research Helper",
    source: "bundled",
    dir: "skills/research-helper",
    declaredTools: ["browser.search"],
    requires: [],
    keywords: ["research"],
    instructionBody: "Help with research.",
    mtime: "2026-05-01T00:00:00.000Z",
    state: "enabled",
    callable: true,
    trustLabel: "trusted",
    ...overrides,
  };
}

describe("filterSkillList", () => {
  const skills = [
    skill({ skillId: "callable", name: "Research Helper", callable: true, state: "enabled" }),
    skill({
      skillId: "review",
      name: "Imported Code Skill",
      source: "managed",
      callable: false,
      state: "sleep",
      reviewWarning: "Needs trust review.",
      declaredTools: ["fs.write"],
      keywords: ["code"],
    }),
    skill({ skillId: "disabled", name: "Archive Assistant", callable: false, state: "disabled", source: "extra" }),
  ];

  it("filters skills by callable, review, state, and searchable metadata", () => {
    expect(filterSkillList(skills, { posture: "callable" }).map((item) => item.skillId)).toEqual(["callable"]);
    expect(filterSkillList(skills, { posture: "review" }).map((item) => item.skillId)).toEqual([
      "review",
      "disabled",
    ]);
    expect(filterSkillList(skills, { posture: "sleep" }).map((item) => item.skillId)).toEqual(["review"]);
    expect(filterSkillList(skills, { query: "fs.write", posture: "all" }).map((item) => item.skillId)).toEqual([
      "review",
    ]);
  });
});
