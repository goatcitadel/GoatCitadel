import { describe, expect, it } from "vitest";
import { listBundledSkillLockEntries } from "@goatcitadel/skills";
import {
  BUNDLED_SKILL_NAME_TAKEN,
  BUNDLED_SKILL_NAME_TAKEN_MESSAGE,
  bundledSkillNames,
  isBundledSkillName,
} from "./plugin-skill-name-rules.js";

describe("plugin skill name rules", () => {
  it("lists every bundled skill name from the lock", () => {
    const entries = listBundledSkillLockEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.skillId.startsWith("bundled:"), entry.skillId).toBe(true);

    const names = bundledSkillNames();
    expect(names.has("receiving-code-review")).toBe(true);
    expect(names.has("documentation")).toBe(true);
    expect([...names].sort()).toEqual(entries.map((entry) => entry.skillId.slice("bundled:".length)).sort());
  });

  it("matches names exactly, ignoring only case", () => {
    expect(isBundledSkillName("receiving-code-review")).toBe(true);
    // The Skill Hub reads skill names case-insensitively, so a re-cased name is the same skill.
    expect(isBundledSkillName("Receiving-Code-Review")).toBe(true);
    expect(isBundledSkillName("RECEIVING-CODE-REVIEW")).toBe(true);
    expect(isBundledSkillName("receiving-code-review-2")).toBe(false);
    expect(isBundledSkillName("receiving_code_review")).toBe(false);
    expect(isBundledSkillName("browser-qa")).toBe(false);
    expect(isBundledSkillName("")).toBe(false);
  });

  it("names the refusal with its code and one plain line", () => {
    expect(BUNDLED_SKILL_NAME_TAKEN).toBe("BUNDLED_SKILL_NAME_TAKEN");
    expect(BUNDLED_SKILL_NAME_TAKEN_MESSAGE).toBe("GoatCitadel already has a built-in skill with this name.");
  });
});
