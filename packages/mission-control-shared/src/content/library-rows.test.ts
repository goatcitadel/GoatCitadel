import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { presentSkillRow } from "./library-rows";

function skill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skillId: "s-1",
    name: "coding",
    state: "enabled",
    instructionBody: "Writes and reviews code. Use it for repository work.",
    ...overrides,
  } as SkillListItem;
}

describe("presentSkillRow", () => {
  it("prefers a routing hint, then an instruction sentence", () => {
    expect(presentSkillRow(skill({ routingHints: { whenToUse: ["Use for code changes."] } as never })).description).toBe("Use for code changes.");
    expect(presentSkillRow(skill()).description).toBe("Writes and reviews code.");
    expect(presentSkillRow(skill({ instructionBody: "" })).description).toBe("No description yet.");
  });

  it("maps skill state and preserves trust", () => {
    expect(presentSkillRow(skill({ state: "enabled", trustLabel: "Built-in" }))).toMatchObject({
      status: { label: "On", tone: "done" }, trust: "Built-in",
    });
    expect(presentSkillRow(skill({ state: "sleep" })).status).toEqual({ label: "Sleeping", tone: "neutral" });
    expect(presentSkillRow(skill({ state: "disabled" })).status).toEqual({ label: "Off", tone: "neutral" });
  });
});
