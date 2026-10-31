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
  it("retrieves description terms without searching instruction bodies", () => {
    const networking = {
      ...skill("networking"),
      description: "Diagnose reverse proxy routing and unreachable containers.",
    };
    const ranked = rankSkillSelectionCandidates({ text: "unreachable containers" }, [networking, skill("unrelated")]);
    expect(ranked.method).toBe("metadata_bm25_v2");
    expect(ranked.candidates.map((candidate) => candidate.skillId)).toEqual(["bundled:networking"]);
    expect(rankSkillSelectionCandidates({ text: "zebras" }, [networking]).candidates).toEqual([]);
  });

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

  it("never nominates an explicit-only skill unless the request names it", () => {
    // Explicit-only: routing hints present with no phrases or keywords, and no keywords of its own.
    const explicitOnly: LoadedSkill = {
      ...skill("ponytail"),
      description: "Use when the operator explicitly asks for the smallest possible change.",
      routingHints: {
        phrases: [],
        keywords: [],
        surfaces: ["code"],
        whenToUse: ["Make the smallest complete change when named."],
        whenNotToUse: [],
      },
    };
    const skills = [explicitOnly, skill("coding", ["change"])];
    const implicit = rankSkillSelectionCandidates({ text: "make the smallest possible change" }, skills);
    expect(implicit.candidates.map((candidate) => candidate.skillId)).toEqual(["bundled:coding"]);
    const named = rankSkillSelectionCandidates({ text: "use ponytail for the smallest possible change" }, skills);
    expect(named.candidates[0]).toMatchObject({ skillId: "bundled:ponytail", explicit: true });
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
