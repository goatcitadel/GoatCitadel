import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { resolveDependencies } from "./deps.js";

function makeSkill(name: string, requires: string[]): LoadedSkill {
  return {
    skillId: name,
    name,
    source: "bundled",
    dir: `/tmp/${name}`,
    declaredTools: [],
    requires,
    keywords: [],
    instructionBody: "",
    mtime: "2025-01-01T00:00:00.000Z",
  };
}

describe("resolveDependencies", () => {
  it("resolves required skills", () => {
    const a = makeSkill("a", ["b"]);
    const b = makeSkill("b", []);
    const result = resolveDependencies([a], [a, b]);

    expect(result.blocked).toHaveLength(0);
    expect(result.ordered.map((s) => s.name)).toEqual(["b", "a"]);
  });

  it("detects cycles", () => {
    const a = makeSkill("a", ["b"]);
    const b = makeSkill("b", ["a"]);
    const result = resolveDependencies([a], [a, b]);

    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.ordered.map((s) => s.name)).toEqual([]);
  });

  it("blocks missing dependencies and dependents without duplicating blocked entries", () => {
    const a = makeSkill("a", ["b"]);
    const c = makeSkill("c", ["a"]);
    const result = resolveDependencies([c, c], [a, c]);

    expect(result.ordered).toEqual([]);
    expect(result.blocked).toEqual([
      { skill: "a", reason: "missing dependency: b" },
      { skill: "c", reason: "blocked by dependency a: c -> a" },
    ]);
  });

  it("deduplicates ordered dependencies selected by multiple initial skills", () => {
    const a = makeSkill("a", ["shared"]);
    const b = makeSkill("b", ["shared"]);
    const shared = makeSkill("shared", []);
    const result = resolveDependencies([a, b, a], [a, b, shared]);

    expect(result.blocked).toEqual([]);
    expect(result.ordered.map((s) => s.name)).toEqual(["shared", "a", "b"]);
  });
});
