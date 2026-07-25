import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { buildSkillDoctorSignals, describeSkillStateOutcome, filterSkillList } from "./LibrarySkillsSection";

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
    revision: overrides.revision ?? 1,
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

// HX-402 P2: skill state changes are approval-first; the notice copy must
// never claim a mutation happened while the skill.lifecycle approval is
// pending, and must name the approval the operator has to resolve.
describe("describeSkillStateOutcome", () => {
  it("names the pending approval and states that nothing changed yet", () => {
    const message = describeSkillStateOutcome(
      { pendingApproval: { approvalId: "11111111-2222-3333-4444-555555555555", status: "pending" } },
      "Research Helper",
      "disabled",
    );
    expect(message).toContain("Approval requested to set Research Helper to disabled");
    expect(message).toContain("11111111-2222-3333-4444-555555555555");
    expect(message).toContain("no change is applied until then");
    expect(message).not.toContain("set to disabled.");
  });

  it("reports a pure no-op when the reviewed state already matches", () => {
    expect(
      describeSkillStateOutcome(
        { pendingApproval: null, noMutationRequired: true, skillState: { skillId: "skill-a", state: "enabled" } },
        "Research Helper",
        "enabled",
      ),
    ).toBe("Research Helper is already enabled; nothing to approve.");
  });

  it("treats malformed responses as no mutation rather than claiming success", () => {
    expect(describeSkillStateOutcome({ updated: true }, "Research Helper", "sleep")).toContain("nothing to approve");
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
