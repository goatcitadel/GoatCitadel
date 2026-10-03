import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { rankSkillSelectionCandidates } from "./selection-ranking.js";
import { resolveSkillActivation } from "./activation.js";

function skill(name: string, keywords: string[] = []): LoadedSkill {
  return {
    skillId: `bundled:${name}`,
    name,
    source: "bundled",
    dir: `/skills/${name}`,
    declaredTools: [],
    requires: [],
    keywords,
    instructionBody: "Never search this instruction body: zebras",
    mtime: "2026-10-02",
  };
}

describe("skill-selection shadow ranking", () => {
  it("matches metadata tokens without substring false positives or reading instructions", () => {
    const skills = [skill("coding", ["code"]), skill("research", ["sources"])];
    expect(resolveSkillActivation({ text: "decode an image" }, skills).selected).toHaveLength(1);
    expect(rankSkillSelectionCandidates({ text: "decode an image zebras" }, skills).candidates).toEqual([]);
  });

  it("weights names above incidental metadata and produces stable ties", () => {
    const skills = [skill("z", ["research"]), skill("a", ["research"]), skill("research")];
    const ranked = rankSkillSelectionCandidates({ text: "research" }, skills);
    expect(ranked.candidates.map((item) => item.skillId)).toEqual(["bundled:research", "bundled:a", "bundled:z"]);
    expect(rankSkillSelectionCandidates({ text: "research" }, [...skills].reverse())).toEqual(ranked);
  });

  it("keeps explicit selection first and honors caller-provided explicit selection", () => {
    const skills = [skill("coding", ["test"]), skill("research")];
    expect(rankSkillSelectionCandidates({ text: "@skill research test" }, skills).candidates[0]).toMatchObject({
      skillId: "bundled:research",
      explicit: true,
    });
    expect(
      rankSkillSelectionCandidates({ text: "use research", explicitSkills: [] }, skills).candidates.every(
        (item) => !item.explicit,
      ),
    ).toBe(true);
  });

  it("does not mutate the existing selector, dependencies, or candidate input", () => {
    const skills = [skill("coding", ["test"]), skill("sources")];
    skills[0]!.requires = ["sources"];
    const original = JSON.stringify(skills);
    const baseline = resolveSkillActivation({ text: "test" }, skills);
    rankSkillSelectionCandidates({ text: "test" }, skills);
    expect(resolveSkillActivation({ text: "test" }, skills)).toEqual(baseline);
    expect(baseline.selected.map((item) => item.name)).toEqual(["sources", "coding"]);
    expect(JSON.stringify(skills)).toBe(original);
  });

  it("bounds queries, candidates, output, and invalid limits", () => {
    const skills = Array.from({ length: 1_001 }, (_, index) => skill(`skill-${index}`, ["test"]));
    const result = rankSkillSelectionCandidates({ text: "test ".repeat(2_000) }, skills, 500);
    expect(result.candidates).toHaveLength(50);
    expect(result.queryTruncated).toBe(true);
    expect(result.candidatesTruncated).toBe(true);
    expect(rankSkillSelectionCandidates({ text: "test" }, skills, -1).candidates).toEqual([]);
    expect(rankSkillSelectionCandidates({ text: "test" }, skills, NaN).candidates).toHaveLength(5);
  });
});
