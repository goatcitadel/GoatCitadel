import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { resolveSkillActivation } from "./activation.js";

function skill(name: string, requires: string[] = [], keywords: string[] = []): LoadedSkill {
  return {
    skillId: name,
    name,
    source: "bundled",
    dir: `/tmp/${name}`,
    declaredTools: [],
    requires,
    keywords,
    instructionBody: "",
    mtime: "2025-01-01T00:00:00.000Z",
  };
}

describe("resolveSkillActivation", () => {
  it("activates explicit skills, keyword matches, and dependencies with reasons", () => {
    const base = skill("research", ["sources"], ["market scan"]);
    const dependency = skill("sources");
    const explicit = skill("planner");

    const result = resolveSkillActivation(
      {
        text: "@skill planner please run a market scan",
      },
      [base, dependency, explicit],
    );

    expect(result.selected.map((item) => item.name)).toEqual(["sources", "research", "planner"]);
    expect(result.reasons).toEqual({
      sources: ["dependency"],
      research: ["keyword"],
      planner: ["explicit"],
    });
    expect(result.selected.every((item) => item.state === "enabled")).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.suppressed).toEqual([]);
  });

  it("uses caller-provided explicit skills when supplied", () => {
    const selected = skill("auditor");
    const skipped = skill("planner");

    const result = resolveSkillActivation(
      {
        text: "use planner",
        explicitSkills: ["auditor"],
      },
      [selected, skipped],
    );

    expect(result.selected.map((item) => item.name)).toEqual(["auditor"]);
    expect(result.reasons.auditor).toEqual(["explicit"]);
    expect(result.reasons.planner).toBeUndefined();
  });
});
