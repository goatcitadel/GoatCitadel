import { describe, expect, it } from "vitest";
import { SKILL_FAMILY_TO_CATEGORY, deriveSkillCategoryLabel, deriveSourceCategoryLabel } from "./SkillsPage";

describe("SkillsPage helpers", () => {
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
