import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BANKR_MIGRATION_CARD_TITLE,
  BANKR_MIGRATION_DOC_PATH,
  BANKR_MIGRATION_TEMPLATE_PATH,
  SKILL_FAMILY_TO_CATEGORY,
  deriveSkillCategoryLabel,
  deriveSourceCategoryLabel,
} from "./SkillsPage";

describe("SkillsPage Bankr migration card", () => {
  it("exports migration card constants", () => {
    expect(BANKR_MIGRATION_CARD_TITLE).toBe("Bankr is Optional");
    expect(BANKR_MIGRATION_DOC_PATH).toBe("docs/OPTIONAL_BANKR_SKILL.md");
    expect(BANKR_MIGRATION_TEMPLATE_PATH).toBe("templates/skills/bankr-optional/SKILL.md");
  });

  it("removes legacy built-in Bankr panel controls", () => {
    const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
    const helpers = readFileSync(new URL("./skills/skills-page-helpers.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Save Bankr policy");
    expect(source).not.toContain("Preview a Bankr action before execution");
    expect(helpers).toContain(BANKR_MIGRATION_CARD_TITLE);
    expect(source).toContain("Best fit:");
    expect(source).toContain("fetchSkillLookup");
    expect(source).toContain("ClawHub");
    expect(source).toContain("Animal House");
    expect(helpers).toContain("Browser & Automation");
  });

  it("derives installed skill categories from tags and tools", () => {
    // "web" matches "Browser & Automation" before "Research & Knowledge" --
    // SKILL_CATEGORY_RULES is evaluated in priority order (first match wins).
    expect(
      deriveSkillCategoryLabel({
        skillId: "bundled:Research",
        name: "Research",
        tags: ["research", "web"],
        declaredTools: ["browser.search"],
        requires: [],
        keywords: ["sources"],
      }),
    ).toBe("Browser & Automation");

    expect(
      deriveSkillCategoryLabel({
        skillId: "bundled:Planning",
        name: "Planning",
        tags: ["planning", "product"],
        declaredTools: ["memory.read"],
        requires: [],
        keywords: ["roadmap"],
      }),
    ).toBe("Planning & Product");
  });

  it("derives optional source categories for curated entries", () => {
    expect(
      deriveSourceCategoryLabel({
        name: "Chrome Devtools Mcp",
        description: "Official browser automation and testing server.",
        tags: ["browser", "mcp", "devtools"],
        skillFamily: "browser_automation",
        sourceUrl: "https://clawhub.ai/aiwithabidi/chrome-devtools-mcp",
        repositoryUrl: undefined,
        upstreamUrl: undefined,
      }),
    ).toBe("Browser & Automation");

    expect(
      deriveSourceCategoryLabel({
        name: "Animal House",
        description: "Virtual creature game for AI agents.",
        tags: ["game", "virtual-pet", "pixel-art"],
        skillFamily: undefined,
        sourceUrl: "https://animalhouse.ai/skills/animal-house",
        repositoryUrl: "https://github.com/geeks-accelerator/animal-house-ai",
        upstreamUrl: "https://animalhouse.ai/skills/animal-house",
      }),
    ).toBe("Games & Experiments");
  });

  it("SKILL_FAMILY_TO_CATEGORY maps every family to a category that exists in rules", () => {
    for (const [family, category] of Object.entries(SKILL_FAMILY_TO_CATEGORY)) {
      expect(
        deriveSourceCategoryLabel({
          name: "test",
          description: "test",
          tags: [],
          skillFamily: family,
          sourceUrl: "",
          repositoryUrl: undefined,
          upstreamUrl: undefined,
        }),
      ).toBe(category);
    }
  });
});
