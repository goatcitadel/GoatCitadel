import { describe, it, expect } from "vitest";
import { resolveActiveUpdateTarget } from "./improvement-service-active-update.js";

describe("resolveActiveUpdateTarget", () => {
  it("prefers a just-loaded skill over a generic prompt-lab target", () => {
    const target = resolveActiveUpdateTarget({
      candidateKind: "skill_revision",
      evidence: [{ source: "prompt_lab", sourceId: "pl-1", refType: "prompt_pack_run" }],
      justLoadedSkillIds: ["skill-alpha"],
    });
    expect(target).toBe("skill:skill-alpha");
  });

  it("falls back to evidence[0] when no skill was just loaded", () => {
    const target = resolveActiveUpdateTarget({
      candidateKind: "skill_revision",
      evidence: [{ source: "skill_evaluation", sourceId: "skill-beta", refType: "skill_evaluation_run" }],
      justLoadedSkillIds: [],
    });
    expect(target).toBe("skill:skill-beta");
  });

  it("prefers the just-loaded skill that matches active turn over a different evidence target", () => {
    const target = resolveActiveUpdateTarget({
      candidateKind: "skill_revision",
      evidence: [{ source: "skill_evaluation", sourceId: "skill-gamma", refType: "skill_evaluation_run" }],
      justLoadedSkillIds: ["skill-alpha"],
    });
    expect(target).toBe("skill:skill-alpha");
  });

  it("never picks a non-skill candidate kind for active-update bias", () => {
    const target = resolveActiveUpdateTarget({
      candidateKind: "routing_policy",
      evidence: [{ source: "prompt_lab", sourceId: "pl-1", refType: "prompt_pack_run" }],
      justLoadedSkillIds: ["skill-alpha"],
    });
    expect(target).toBe("prompt-lab:pl-1");
  });

  it("uses memory: prefix for memory-sourced evidence", () => {
    const target = resolveActiveUpdateTarget({
      candidateKind: "routing_policy",
      evidence: [{ source: "memory", sourceId: "mem-1", refType: "artifact_manifest" }],
      justLoadedSkillIds: [],
    });
    expect(target).toBe("memory:mem-1");
  });
});
