import { describe, expect, it } from "vitest";
import { filterSkillItemsByEffectiveSet } from "./capability-system-service.js";

describe("filterSkillItemsByEffectiveSet", () => {
  const items = [
    { skillId: "a", name: "A" },
    { skillId: "b", name: "B" },
  ] as Array<{ skillId: string; name: string }>;

  it("returns all items when the effective set is ALL", () => {
    expect(filterSkillItemsByEffectiveSet(items, "ALL")).toHaveLength(2);
  });

  it("keeps only items in the effective set", () => {
    const result = filterSkillItemsByEffectiveSet(items, new Set(["a"]));
    expect(result.map((i) => i.skillId)).toEqual(["a"]);
  });

  it("returns empty array when effective set is an empty Set", () => {
    const result = filterSkillItemsByEffectiveSet(items, new Set<string>());
    expect(result).toHaveLength(0);
  });

  it("is non-mutating — original array is unchanged", () => {
    const copy = [...items];
    filterSkillItemsByEffectiveSet(items, new Set(["a"]));
    expect(items).toEqual(copy);
  });
});
