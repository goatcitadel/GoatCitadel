import { describe, expect, it } from "vitest";
import {
  enumerateSkillRoutes,
  extractExplicitSkillCommand,
  IMPECCABLE_BUDGET_BYTES,
  IMPECCABLE_COMMANDS,
  IMPECCABLE_MODULE_MAX_BYTES,
  resolveSkillModules,
} from "./skill-module-routes.js";

const impeccable = { skillId: "bundled:impeccable", skillName: "impeccable" };
const designIntelligence = { skillId: "bundled:design-intelligence", skillName: "design-intelligence" };

function paths(resolution: ReturnType<typeof resolveSkillModules>): string[] {
  return resolution.modules.map((module) => module.relativePath);
}

describe("resolveSkillModules", () => {
  it("loads the skill body and the craft floor for an ordinary design request", () => {
    const resolution = resolveSkillModules({ ...impeccable, text: "Make the settings page feel less generic." });

    expect(resolution.routeId).toBe("design");
    expect(resolution.command).toBeUndefined();
    expect(paths(resolution)).toEqual(["SKILL.md", "reference/craft-floor.md"]);
    expect(resolution.modules.map((module) => module.name)).toEqual(["main", "craft-floor"]);
    expect(resolution.budgetBytes).toBe(IMPECCABLE_BUDGET_BYTES);
    expect(resolution.modules.every((module) => module.maxBytes === IMPECCABLE_MODULE_MAX_BYTES)).toBe(true);
  });

  it("loads the artifacts module instead of the craft floor for deck and document intents", () => {
    const deck = resolveSkillModules({
      ...impeccable,
      text: "Create a polished deck about Q3.",
      artifactIntent: { presentation: true, document: false },
    });
    expect(deck.routeId).toBe("artifacts");
    expect(paths(deck)).toEqual(["SKILL.md", "reference/artifacts.md"]);
    expect(deck.modules.map((module) => module.name)).toEqual(["main", "artifacts"]);

    const document = resolveSkillModules({
      ...impeccable,
      text: "Write the brief as a PDF.",
      artifactIntent: { presentation: false, document: true },
    });
    expect(paths(document)).toEqual(["SKILL.md", "reference/artifacts.md"]);
  });

  it("adds the command module after the craft floor for an explicit refine command", () => {
    const resolution = resolveSkillModules({ ...impeccable, text: "@skill impeccable polish the settings page" });

    expect(resolution.routeId).toBe("command:polish");
    expect(resolution.command).toBe("polish");
    expect(paths(resolution)).toEqual(["SKILL.md", "reference/craft-floor.md", "reference/polish.md"]);
    expect(resolution.modules.map((module) => module.name)).toEqual(["main", "craft-floor", "polish"]);
  });

  it("skips the craft floor for build and evaluate commands", () => {
    for (const command of ["shape", "init", "document", "extract", "audit"]) {
      const resolution = resolveSkillModules({ ...impeccable, text: `@skill impeccable ${command} the current app` });
      expect(resolution.command).toBe(command);
      expect(paths(resolution)).toEqual(["SKILL.md", `reference/${command}.md`]);
    }
  });

  it("recognises the $skillId and use forms of an explicit command", () => {
    expect(resolveSkillModules({ ...impeccable, text: "$bundled:impeccable typeset the hero" }).command).toBe(
      "typeset",
    );
    expect(resolveSkillModules({ ...impeccable, text: "Please use impeccable audit this page." }).command).toBe(
      "audit",
    );
  });

  it("falls back to the design route when the word after the mention is not a command", () => {
    const resolution = resolveSkillModules({ ...impeccable, text: "@skill impeccable fly away with this page" });
    expect(resolution.routeId).toBe("design");
    expect(resolution.command).toBeUndefined();
    expect(paths(resolution)).toEqual(["SKILL.md", "reference/craft-floor.md"]);
  });

  it("lets an explicit command win over an artifact intent", () => {
    const resolution = resolveSkillModules({
      ...impeccable,
      text: "@skill impeccable audit this deck",
      artifactIntent: { presentation: true, document: false },
    });
    expect(resolution.command).toBe("audit");
    expect(paths(resolution)).toEqual(["SKILL.md", "reference/audit.md"]);
  });

  it("reproduces design-intelligence's presentation routing", () => {
    const deck = resolveSkillModules({ ...designIntelligence, text: "Create a slide deck about onboarding." });
    expect(deck.modules).toEqual([{ name: "presentation", relativePath: "presentation.md", maxBytes: 8 * 1024 }]);

    const other = resolveSkillModules({ ...designIntelligence, text: "Review this settings form." });
    expect(other.modules).toEqual([{ name: "main", relativePath: "SKILL.md" }]);
  });

  it("gives any other skill only its main module", () => {
    const resolution = resolveSkillModules({ skillId: "bundled:coding", skillName: "coding", text: "fix the bug" });
    expect(resolution.routeId).toBe("main");
    expect(resolution.modules).toEqual([{ name: "main", relativePath: "SKILL.md" }]);
    expect(resolution.budgetBytes).toBe(64 * 1024);
  });
});

describe("extractExplicitSkillCommand", () => {
  it("returns the command word that follows an explicit mention, case-insensitively", () => {
    expect(extractExplicitSkillCommand("@skill Impeccable Polish the hero", "impeccable", IMPECCABLE_COMMANDS)).toBe(
      "polish",
    );
    expect(extractExplicitSkillCommand("$bundled:impeccable layout", "impeccable", IMPECCABLE_COMMANDS)).toBe("layout");
    expect(extractExplicitSkillCommand("use impeccable colorize this", "impeccable", IMPECCABLE_COMMANDS)).toBe(
      "colorize",
    );
  });

  it("returns undefined without a mention, without a following word, or with a non-command word", () => {
    expect(extractExplicitSkillCommand("polish the hero", "impeccable", IMPECCABLE_COMMANDS)).toBeUndefined();
    expect(extractExplicitSkillCommand("@skill impeccable", "impeccable", IMPECCABLE_COMMANDS)).toBeUndefined();
    expect(
      extractExplicitSkillCommand("use impeccable because it is good", "impeccable", IMPECCABLE_COMMANDS),
    ).toBeUndefined();
  });
});

describe("enumerateSkillRoutes", () => {
  it("lists every impeccable route the gateway can resolve", () => {
    const routes = enumerateSkillRoutes(impeccable);

    expect(routes.map((route) => route.routeId)).toEqual([
      "design",
      "artifacts",
      ...IMPECCABLE_COMMANDS.map((command) => `command:${command}`),
    ]);
    expect(routes.find((route) => route.routeId === "command:polish")?.modules.map((m) => m.relativePath)).toEqual([
      "SKILL.md",
      "reference/craft-floor.md",
      "reference/polish.md",
    ]);
    // critique evaluates and never edits UI, so it loads no craft floor.
    expect(routes.find((route) => route.routeId === "command:critique")?.modules.map((m) => m.relativePath)).toEqual([
      "SKILL.md",
      "reference/critique.md",
    ]);
    expect(routes.every((route) => route.budgetBytes === IMPECCABLE_BUDGET_BYTES)).toBe(true);
  });

  it("lists the main and presentation routes for design-intelligence and only main otherwise", () => {
    expect(enumerateSkillRoutes(designIntelligence).map((route) => route.routeId)).toEqual(["main", "presentation"]);
    expect(
      enumerateSkillRoutes({ skillId: "bundled:coding", skillName: "coding" }).map((route) => route.routeId),
    ).toEqual(["main"]);
  });

  it("declares the workspace context docs on every impeccable route and on no other skill", () => {
    expect(enumerateSkillRoutes(impeccable).every((route) => route.contextDocs?.join(",") === "product,design")).toBe(
      true,
    );
    expect(resolveSkillModules({ ...impeccable, text: "Polish this page." }).contextDocs).toEqual([
      "product",
      "design",
    ]);
    expect(resolveSkillModules({ ...designIntelligence, text: "Polish this page." }).contextDocs).toBeUndefined();
    expect(
      resolveSkillModules({ skillId: "bundled:coding", skillName: "coding", text: "Fix the bug." }).contextDocs,
    ).toBeUndefined();
  });
});
