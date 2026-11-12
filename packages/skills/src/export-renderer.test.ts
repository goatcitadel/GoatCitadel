import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { listSkillExportTargets, renderSkillExportPreview } from "./export-renderer.js";

const skill: LoadedSkill = {
  skillId: "bundled:coding",
  name: "coding",
  source: "bundled",
  dir: "/skills/coding",
  tags: ["code"],
  declaredTools: ["shell.exec"],
  requires: [],
  keywords: ["implement"],
  routingHints: {
    phrases: ["implement"],
    keywords: ["code"],
    surfaces: ["code"],
    whenToUse: ["Make small code changes."],
    whenNotToUse: ["Do not bypass policy."],
  },
  instructionBody: "# Coding\n\nImplement with tests.",
  mtime: "2026-05-27T00:00:00.000Z",
};

describe("skill export renderer", () => {
  it("reports when two selected skills would export to the same path", () => {
    const underscore = { ...skill, skillId: "workspace:daily_notes", name: "daily_notes" };
    const hyphen = { ...skill, skillId: "workspace:daily-notes", name: "daily-notes" };

    expect(() =>
      renderSkillExportPreview(
        { skillIds: [underscore.skillId, hyphen.skillId], target: "generic-markdown" },
        [underscore, hyphen],
      ),
    ).toThrow(/both.*daily-notes\/SKILL\.md/i);
  });

  it("reports when a selected skill name cannot produce a relative export path", () => {
    const nonLatin = { ...skill, skillId: "workspace:notes", name: "日誌" };

    expect(() =>
      renderSkillExportPreview({ skillIds: [nonLatin.skillId], target: "generic-markdown" }, [nonLatin]),
    ).toThrow(/relative export path/i);
  });

  it("lists preview-only export targets", () => {
    expect(listSkillExportTargets().map((target) => target.target)).toEqual(["codex", "claude", "generic-markdown"]);
    expect(listSkillExportTargets().every((target) => target.previewOnly)).toBe(true);
  });

  it("renders boundary-preserving markdown without internal metadata", () => {
    const preview = renderSkillExportPreview(
      {
        skillIds: ["bundled:coding"],
        target: "generic-markdown",
      },
      [skill],
    );

    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]?.content).toContain("Tool access, approvals, memory writes");
    expect(preview.files[0]?.content).toContain("## When To Use");
    expect(preview.files[0]?.content).not.toContain("declaredTools");
    expect(preview.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
