import { describe, expect, it } from "vitest";
import { checkSkillFrontmatterShape } from "./skill-hub-frontmatter-shape.js";

const BASE = { name: "pdf-notes", description: "Turns a PDF into short meeting notes for the team." };

describe("checkSkillFrontmatterShape", () => {
  // The SKILL.md parser reads a plain string as no metadata, so this branch is reached only from parsed frontmatter.
  it("refuses a native skill whose metadata isn't an object", () => {
    expect(checkSkillFrontmatterShape({ ...BASE, metadata: "x" }, undefined)).toEqual({
      ok: false,
      code: "UNKNOWN_FRONTMATTER_DIMENSION",
      message: "Skill metadata is not a known permission shape.",
    });
  });

  it("passes a native skill's own metadata and keeps its version", () => {
    expect(checkSkillFrontmatterShape({ ...BASE, metadata: { version: " 1.0.0 ", tools: [] } }, undefined)).toEqual({
      ok: true,
      shape: { declaredVersion: "1.0.0" },
    });
  });
});
