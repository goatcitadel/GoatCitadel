import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry, LoadedSkill } from "@goatcitadel/contracts";
import { evaluateCallableSkillSelection, resolveCallableSkillActivation } from "./callable-skill-activation.js";

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
