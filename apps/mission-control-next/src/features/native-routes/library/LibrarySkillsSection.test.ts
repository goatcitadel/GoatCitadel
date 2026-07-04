import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { buildSkillDoctorSignals, filterSkillList } from "./LibrarySkillsSection";

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
    expect(filterSkillList(skills, { posture: "review" }).map((item) => item.skillId)).toEqual(["review", "disabled"]);
    expect(filterSkillList(skills, { posture: "sleep" }).map((item) => item.skillId)).toEqual(["review"]);
    expect(filterSkillList(skills, { query: "fs.write", posture: "all" }).map((item) => item.skillId)).toEqual([
      "review",
    ]);
  });
});

describe("buildSkillDoctorSignals", () => {
  it("marks callable trusted skills as ready with provenance and tool scope", () => {
    const signals = buildSkillDoctorSignals(
      skill({
        lifecycleState: "trusted",
        lifecycle: {
          skillId: "skill-a",
          category: "project_local",
          lifecycleState: "trusted",
          trustLabel: "trusted",
          provenance: {
            source: "managed",
            sourceRef: "skills/research-helper/SKILL.md",
            sourceProvider: "local",
          },
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      }),
    );

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "trust-doctor", value: "Ready", tone: "success" }),
        expect.objectContaining({ id: "provenance-doctor", value: "local", tone: "success" }),
        expect.objectContaining({ id: "tool-doctor", value: "1 declared", tone: "info" }),
      ]),
    );
  });

  it("marks imported non-callable skills as review-needed and unmanaged", () => {
    const signals = buildSkillDoctorSignals(
      skill({
        callable: false,
        state: "sleep",
        trustLabel: undefined,
        reviewWarning: "Imported skill needs trust review.",
        lifecycleState: undefined,
        lifecycle: undefined,
        declaredTools: [],
      }),
    );

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "trust-doctor",
          value: "Review needed",
          tone: "warning",
          description: "Imported skill needs trust review.",
        }),
        expect.objectContaining({ id: "provenance-doctor", value: "Unmanaged", tone: "warning" }),
        expect.objectContaining({ id: "tool-doctor", value: "0 declared", tone: "neutral" }),
      ]),
    );
  });
});
