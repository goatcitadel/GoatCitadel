import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { resolveSkillActivation } from "./activation.js";
import { GENERATED_SKILL_ROUTING_HINTS } from "./routing-hints.generated.js";

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

  it("activates impeccable for artifact, deck, document, and UI design prompts but not backend work", () => {
    const impeccable = {
      ...skill("impeccable"),
      skillId: "bundled:impeccable",
      routingHints: GENERATED_SKILL_ROUTING_HINTS.impeccable,
    };

    const deck = resolveSkillActivation(
      { text: "Create a real PowerPoint slide deck and a PDF brief with good document design." },
      [impeccable],
    );
    expect(deck.selected.map((item) => item.name)).toEqual(["impeccable"]);
    expect(deck.reasons.impeccable).toEqual(expect.arrayContaining(["routing_keyword", "routing_phrase"]));
    expect(deck.selected[0]?.confidence).toBeGreaterThan(0.85);

    const ui = resolveSkillActivation({ text: "Make the dashboard landing page look less generic." }, [impeccable]);
    expect(ui.selected.map((item) => item.name)).toEqual(["impeccable"]);

    const backend = resolveSkillActivation(
      { text: "Fix the TypeScript error in the gateway route and add a regression test." },
      [impeccable],
    );
    expect(backend.selected).toEqual([]);
  });

  it("treats a $skillId mention as an explicit activation", () => {
    const impeccable = { ...skill("impeccable"), skillId: "bundled:impeccable" };

    const result = resolveSkillActivation({ text: "$bundled:impeccable polish this hero" }, [impeccable]);
    expect(result.selected.map((item) => item.name)).toEqual(["impeccable"]);
    expect(result.reasons.impeccable).toEqual(["explicit"]);
  });

  it("ignores a $ that is not a skill-id mention at a token start", () => {
    const research = { ...skill("research"), skillId: "bundled:research" };

    const shell = resolveSkillActivation({ text: "echo $research\n$research = 1; price$bundled:research" }, [research]);
    expect(shell.selected).toEqual([]);
  });

  it("does not activate impeccable on bare generic words in ordinary engineering prompts", () => {
    const impeccable = {
      ...skill("impeccable"),
      skillId: "bundled:impeccable",
      routingHints: GENERATED_SKILL_ROUTING_HINTS.impeccable,
    };

    for (const text of [
      "Fix the component's null check and add a coverage report.",
      "The dashboard endpoint returns 500 after landing the PR.",
      "Fix the Linux build; give me a brief summary of the log.",
      "Open index.html and check the artifact path.",
    ]) {
      expect(resolveSkillActivation({ text }, [impeccable]).selected, text).toEqual([]);
    }
    for (const text of ["Build a dashboard ui for runtime health.", "Write a pdf report on the Q3 numbers."]) {
      expect(
        resolveSkillActivation({ text }, [impeccable]).selected.map((item) => item.name),
        text,
      ).toEqual(["impeccable"]);
    }
  });
});
