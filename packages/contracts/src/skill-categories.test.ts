import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_SKILL_CATEGORIES,
  SKILL_CATEGORIES,
  SKILL_ORIGIN_LABELS,
  skillCategoryFor,
  type SkillCategoryId,
} from "./skill-categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogCoveragePath = resolve(__dirname, "../../../skills/catalog-coverage.json");

describe("skill categories", () => {
  it("lists 11 categories with unique ids and Other last", () => {
    expect(SKILL_CATEGORIES).toHaveLength(11);
    const ids = SKILL_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe("other");
    expect(SKILL_CATEGORIES.at(-1)?.matchTerms).toEqual([]);
  });

  it("keeps every match term lower-case", () => {
    for (const category of SKILL_CATEGORIES) {
      for (const term of category.matchTerms) {
        expect(term).toBe(term.toLowerCase());
      }
    }
  });

  it("maps every skill in skills/catalog-coverage.json and nothing else", () => {
    const coverage = JSON.parse(readFileSync(catalogCoveragePath, "utf8")) as {
      entries: Array<{ skillId: string }>;
    };
    const coverageIds = coverage.entries.map((entry) => entry.skillId).sort();
    expect(Object.keys(SHIPPED_SKILL_CATEGORIES).sort()).toEqual(coverageIds);
    expect(coverageIds).toHaveLength(20);
  });

  it("only maps shipped skills to a known category", () => {
    const known = new Set<string>(SKILL_CATEGORIES.map((category) => category.id));
    for (const categoryId of Object.values(SHIPPED_SKILL_CATEGORIES)) {
      expect(known.has(categoryId)).toBe(true);
    }
  });

  it("uses the shipped map before tags", () => {
    expect(skillCategoryFor({ skillId: "bundled:qa", tags: ["email"] })).toBe("coding");
  });

  it.each<{
    name: string;
    input: { skillId: string; tags?: string[]; keywords?: string[] };
    expected: SkillCategoryId;
  }>([
    {
      name: "tag is matched case-insensitively",
      input: { skillId: "workspace:x", tags: ["Email"] },
      expected: "email",
    },
    {
      name: "an unknown tag falls back to other",
      input: { skillId: "workspace:x", tags: ["unknown"] },
      expected: "other",
    },
    { name: "no tags or keywords falls back to other", input: { skillId: "workspace:x" }, expected: "other" },
    {
      name: "table order wins over tag order",
      input: { skillId: "workspace:x", tags: ["design", "code"] },
      expected: "coding",
    },
    { name: "a keyword alone matches", input: { skillId: "workspace:x", keywords: ["Roadmap"] }, expected: "planning" },
    { name: "a tag matches a whole term only", input: { skillId: "workspace:x", tags: ["codex"] }, expected: "other" },
    { name: "an inherited object key is not a shipped skill", input: { skillId: "constructor" }, expected: "other" },
  ])("$name", ({ input, expected }) => {
    expect(skillCategoryFor(input)).toBe(expected);
  });
});

describe("skill origin labels", () => {
  it("labels every origin in plain words", () => {
    expect(SKILL_ORIGIN_LABELS).toEqual({
      built_in: "Built in",
      imported: "Imported",
      self_authored: "Self-authored",
      workspace: "Workspace",
    });
  });
});
