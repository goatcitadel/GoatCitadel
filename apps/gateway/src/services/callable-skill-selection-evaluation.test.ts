import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry, LoadedSkill } from "@goatcitadel/contracts";
import {
  evaluateCallableSkillSelection,
  resolveCallableSkillActivation,
  resolveCallableSkillSelection,
  type CallableSkillSelectionInput,
} from "./callable-skill-activation.js";

const skills: LoadedSkill[] = ["active", "inactive", "missing"].map((name) => ({
  skillId: `extra:${name}`,
  name,
  source: "extra",
  dir: `/skills/${name}`,
  declaredTools: [],
  requires: [],
  keywords: ["research"],
  instructionBody: "",
  mtime: "",
}));
const entries: CapabilityCatalogEntry[] = skills.slice(0, 2).map((skill, index) => ({
  capabilityId: `skill:${skill.skillId}`,
  kind: "skill",
  category: "community_imported",
  title: skill.name,
  summary: "research",
  callable: index === 0,
  lifecycleState: index === 0 ? "approved" : "candidate",
  skillId: skill.skillId,
}));

describe("callable skill-selection evaluation", () => {
  it("defaults to legacy and keeps shadow ranking observational", () => {
    const input = selectionInput([loaded("coding", ["code"]), loaded("networking", [], "Unreachable containers")], "decode containers");
    const legacy = resolveCallableSkillSelection(input);
    const shadow = resolveCallableSkillSelection(input, { mode: "shadow" });
    expect(legacy.mode).toBe("legacy");
    expect(legacy.ranking).toBeUndefined();
    expect(shadow.decision).toEqual(legacy.decision);
    expect(legacy.decision.selected.map((skill) => skill.name)).toEqual(["coding"]);
    expect(shadow.ranking?.candidates.map((candidate) => candidate.skillId)).toEqual(["extra:networking"]);
  });

  it("uses metadata relevance without promoting the match into explicit authority", () => {
    const input = selectionInput([loaded("coding", ["code"]), loaded("networking", [], "Unreachable containers")], "decode containers");
    const result = resolveCallableSkillSelection(input, { mode: "ranked" });
    expect(result.decision.selected.map((skill) => skill.name)).toEqual(["networking"]);
    expect(result.decision.reasons).toEqual({ networking: ["metadata_ranked"] });
    expect(result.decision.selected[0]?.confidence).not.toBe(result.ranking?.candidates[0]?.score);
  });

  it("caps evidence at five candidates and automatic base selection at three", () => {
    const input = selectionInput(Array.from({ length: 8 }, (_, index) => loaded(`skill-${index}`, ["research"])), "research");
    const result = resolveCallableSkillSelection(input, { mode: "ranked" });
    expect(result.ranking?.candidates).toHaveLength(5);
    expect(result.decision.selected).toHaveLength(3);
    expect(result.decision.selected.map((skill) => skill.name)).toEqual(["skill-0", "skill-1", "skill-2"]);
    expect(result.decision.selected.every((skill) => !result.decision.reasons[skill.name]?.includes("explicit"))).toBe(true);
  });

  it("preserves every callable explicit request and required callable dependency", () => {
    const loadedSkills = Array.from({ length: 7 }, (_, index) => loaded(`skill-${index}`));
    loadedSkills[0]!.requires = ["dependency"];
    loadedSkills.push(loaded("dependency"));
    const input = selectionInput(loadedSkills, "");
    input.request.explicitSkills = loadedSkills.slice(0, 7).map((skill) => `skill:${skill.skillId}`);
    const result = resolveCallableSkillSelection(input, { mode: "ranked" });
    expect(result.ranking?.candidates).toHaveLength(5);
    expect(result.decision.selected).toHaveLength(8);
    expect(result.decision.selected[0]?.name).toBe("dependency");
    expect(result.decision.reasons.dependency).toEqual(["dependency"]);
    expect(result.decision.reasons["skill-0"]).toEqual(["explicit"]);
  });

  it("does not resolve dependencies from inactive or absent catalog records", () => {
    const parent = loaded("parent", [], "container diagnosis");
    parent.requires = ["inactive"];
    const input = selectionInput([parent, loaded("inactive")], "container diagnosis @skill extra:inactive");
    input.callableCatalog = input.callableCatalog.filter((entry) => entry.skillId !== "extra:inactive");
    input.inspectableCatalog[1] = { ...input.inspectableCatalog[1]!, callable: false, lifecycleState: "candidate" };
    const result = resolveCallableSkillSelection(input, { mode: "ranked" });
    expect(result.decision.selected).toEqual([]);
    expect(result.decision.blocked).toContainEqual({ skill: "parent", reason: "missing dependency: inactive" });
    expect(result.decision.blocked).toContainEqual({ skill: "extra:inactive", reason: "skill_not_callable" });
  });

  it("abstains on unknown input even if malformed metadata has empty keywords", () => {
    const input = selectionInput([loaded("networking", [""])], "zebras");
    const result = resolveCallableSkillSelection(input, { mode: "ranked" });
    expect(result.ranking?.candidates).toEqual([]);
    expect(result.decision.selected).toEqual([]);
  });

  it("excludes inactive and missing skills from both ranking and runtime selection", () => {
    const input = {
      request: { text: "research" },
      loadedSkills: skills,
      callableCatalog: entries,
      inspectableCatalog: entries,
    };
    const result = evaluateCallableSkillSelection(input);
    expect(result.shadow.candidates.map((item) => item.skillId)).toEqual(["extra:active"]);
    expect(result.decision).toEqual(resolveCallableSkillActivation(input));
  });

  it("preserves blocked explicit requests instead of granting shadow activation", () => {
    const input = {
      request: { text: "", explicitSkills: ["extra:inactive"] },
      loadedSkills: skills,
      callableCatalog: entries,
      inspectableCatalog: entries,
    };
    const result = evaluateCallableSkillSelection(input);
    expect(result.shadow.candidates).toEqual([]);
    expect(result.decision.blocked).toContainEqual({ skill: "extra:inactive", reason: "skill_not_callable" });
  });

  it("normalizes canonical callable aliases before ranking explicit requests", () => {
    const input = {
      request: { text: "", explicitSkills: ["skill:extra:active"] },
      loadedSkills: skills,
      callableCatalog: entries,
      inspectableCatalog: entries,
    };
    expect(evaluateCallableSkillSelection(input).shadow.candidates[0]).toMatchObject({
      skillId: "extra:active",
      explicit: true,
    });
  });
});

function loaded(name: string, keywords: string[] = [], description?: string): LoadedSkill {
  return { skillId: `extra:${name}`, name, description, keywords, source: "extra", dir: `/skills/${name}`,
    declaredTools: [], requires: [], instructionBody: "Private instructions must not participate in discovery", mtime: "" };
}

function selectionInput(loadedSkills: LoadedSkill[], text: string): CallableSkillSelectionInput {
  const catalog: CapabilityCatalogEntry[] = loadedSkills.map((skill) => ({
    capabilityId: `skill:${skill.skillId}`, kind: "skill", category: "community_imported", title: skill.name,
    summary: skill.description ?? "", callable: true, lifecycleState: "approved", skillId: skill.skillId,
  }));
  return { request: { text }, loadedSkills, callableCatalog: [...catalog], inspectableCatalog: [...catalog] };
}
