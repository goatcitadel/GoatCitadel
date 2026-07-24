import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry, LoadedSkill } from "@goatcitadel/contracts";
import { resolveCallableSkillActivation } from "./callable-skill-activation.js";

const active = skill("extra:active", "active", ["activate-me"]);
const inactive = skill("extra:inactive", "inactive", ["inactive-keyword"]);

describe("resolveCallableSkillActivation", () => {
  it("selects only skills present in the callable catalog", () => {
    const result = resolve({ text: "activate-me inactive-keyword" });

    expect(result.selected.map((item) => item.skillId)).toEqual(["extra:active"]);
    expect(result.selected.some((item) => item.skillId === "extra:inactive")).toBe(false);
  });

  it.each([
    ["extra:inactive", "inactive skill id"],
    ["skill:extra:inactive", "inactive capability id"],
    ["candidate-1", "candidate id"],
    ["candidate:candidate-1:version-1", "candidate capability id"],
  ])("blocks explicit noncallable %s (%s)", (token) => {
    const result = resolve({ text: "", explicitSkills: [token] });

    expect(result.selected).toEqual([]);
    expect(result.blocked).toContainEqual({ skill: token, reason: "skill_not_callable" });
  });

  it("normalizes callable capability and skill IDs to the loaded skill name", () => {
    for (const explicit of ["extra:active", "skill:extra:active"]) {
      expect(resolve({ text: "", explicitSkills: [explicit] }).selected.map((item) => item.skillId)).toEqual([
        "extra:active",
      ]);
    }
  });
});

function resolve(request: { text: string; explicitSkills?: string[] }) {
  return resolveCallableSkillActivation({
    request,
    loadedSkills: [active, inactive],
    callableCatalog: [catalogSkill(active, true, "approved")],
    inspectableCatalog: [
      catalogSkill(active, true, "approved"),
      catalogSkill(inactive, false, "candidate"),
      {
        capabilityId: "candidate:candidate-1:version-1",
        kind: "candidate_skill",
        category: "community_imported",
        title: "candidate one",
        summary: "inactive candidate",
        callable: false,
        lifecycleState: "candidate",
        candidateId: "candidate-1",
      },
    ],
  });
}

function skill(skillId: string, name: string, keywords: string[]): LoadedSkill {
  return {
    skillId,
    name,
    source: "extra",
    dir: `/skills/${name}`,
    declaredTools: [],
    requires: [],
    keywords,
    instructionBody: `${name} instructions`,
    mtime: "2026-07-14T00:00:00.000Z",
  };
}

function catalogSkill(
  loaded: LoadedSkill,
  callable: boolean,
  lifecycleState: "approved" | "candidate",
): CapabilityCatalogEntry {
  return {
    capabilityId: `skill:${loaded.skillId}`,
    kind: "skill",
    category: "community_imported",
    title: loaded.name,
    summary: loaded.instructionBody,
    callable,
    lifecycleState,
    skillId: loaded.skillId,
  };
}
