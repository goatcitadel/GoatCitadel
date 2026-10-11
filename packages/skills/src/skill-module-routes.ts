/**
 * Code-owned module routes for governed runtime skills.
 *
 * A runtime skill is injected as one or more exact-byte-verified modules. The
 * route table decides which modules a turn loads from the skill's frozen tree,
 * so the decision is tied to the release rather than to the skill's files
 * (changing a trusted bundled skill's files demotes it; changing this table
 * does not). The gateway enforces the byte limits the resolution carries.
 */

export interface SkillModuleRef {
  /** Stable logical module name recorded in the activation receipt. */
  name: string;
  /** Skill-root-relative path, forward slashes. */
  relativePath: string;
  /** Per-module byte ceiling the gateway enforces before injection. */
  maxBytes?: number;
}

export interface SkillArtifactIntent {
  presentation: boolean;
  document: boolean;
}

export interface ResolveSkillModulesInput {
  skillId: string;
  skillName: string;
  /** The turn's user content. */
  text: string;
  artifactIntent?: SkillArtifactIntent;
}

export interface SkillModuleResolution {
  routeId: string;
  command?: string;
  modules: SkillModuleRef[];
  /** Total byte ceiling across the resolved modules. */
  budgetBytes: number;
}

export const IMPECCABLE_SKILL_NAME = "impeccable";
export const DESIGN_INTELLIGENCE_SKILL_NAME = "design-intelligence";

/** The impeccable commands this build vendors, in Commands-table order. */
export const IMPECCABLE_COMMANDS: readonly string[] = Object.freeze([
  "shape",
  "init",
  "document",
  "extract",
  "audit",
  "polish",
  "bolder",
  "quieter",
  "distill",
  "harden",
  "onboard",
  "animate",
  "colorize",
  "typeset",
  "layout",
  "delight",
  "overdrive",
  "clarify",
  "adapt",
  "optimize",
]);

/** Commands that edit UI and therefore load the craft floor before the command module. */
export const IMPECCABLE_CRAFT_COMMANDS: readonly string[] = Object.freeze([
  "polish",
  "bolder",
  "quieter",
  "distill",
  "harden",
  "onboard",
  "animate",
  "colorize",
  "typeset",
  "layout",
  "delight",
  "overdrive",
  "clarify",
  "adapt",
  "optimize",
]);

export const IMPECCABLE_BUDGET_BYTES = 40 * 1024;
export const IMPECCABLE_MODULE_MAX_BYTES = 24 * 1024;
export const DEFAULT_SKILL_BUDGET_BYTES = 64 * 1024;
const DESIGN_INTELLIGENCE_PRESENTATION_MAX_BYTES = 8 * 1024;

/** Same presentation trigger the governed instruction service used before the route table existed. */
const PRESENTATION_INTENT = /\b(?:powerpoint|presentation|slide\s*deck|slides?|pptx|presentations\.create)\b/iu;

const MAIN_MODULE: SkillModuleRef = Object.freeze({ name: "main", relativePath: "SKILL.md" });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The command word that follows an explicit mention of the skill: `@skill <name> <cmd>`,
 * `use <name> <cmd>`, or `$<source>:<name> <cmd>`. Only a word from `commands` counts.
 */
export function extractExplicitSkillCommand(
  text: string,
  skillName: string,
  commands: readonly string[],
): string | undefined {
  const pattern = new RegExp(
    `(?:@skill\\s+|\\$|\\buse\\s+)(?:[a-z0-9_-]+:)?${escapeRegExp(skillName)}\\s+([a-z][a-z0-9-]*)`,
    "iu",
  );
  const candidate = pattern.exec(text)?.[1]?.toLowerCase();
  return candidate && commands.includes(candidate) ? candidate : undefined;
}

function impeccableModule(name: string, relativePath: string): SkillModuleRef {
  return { name, relativePath, maxBytes: IMPECCABLE_MODULE_MAX_BYTES };
}

function resolveImpeccableModules(input: ResolveSkillModulesInput): SkillModuleResolution {
  const main = impeccableModule("main", "SKILL.md");
  const craftFloor = impeccableModule("craft-floor", "reference/craft-floor.md");
  const command = extractExplicitSkillCommand(input.text, IMPECCABLE_SKILL_NAME, IMPECCABLE_COMMANDS);
  if (command) {
    const modules = IMPECCABLE_CRAFT_COMMANDS.includes(command)
      ? [main, craftFloor, impeccableModule(command, `reference/${command}.md`)]
      : [main, impeccableModule(command, `reference/${command}.md`)];
    return { routeId: `command:${command}`, command, modules, budgetBytes: IMPECCABLE_BUDGET_BYTES };
  }
  if (input.artifactIntent?.presentation || input.artifactIntent?.document) {
    return {
      routeId: "artifacts",
      modules: [main, impeccableModule("artifacts", "reference/artifacts.md")],
      budgetBytes: IMPECCABLE_BUDGET_BYTES,
    };
  }
  return { routeId: "design", modules: [main, craftFloor], budgetBytes: IMPECCABLE_BUDGET_BYTES };
}

function resolveDesignIntelligenceModules(input: ResolveSkillModulesInput): SkillModuleResolution {
  if (PRESENTATION_INTENT.test(input.text)) {
    return {
      routeId: "presentation",
      modules: [
        { name: "presentation", relativePath: "presentation.md", maxBytes: DESIGN_INTELLIGENCE_PRESENTATION_MAX_BYTES },
      ],
      budgetBytes: DEFAULT_SKILL_BUDGET_BYTES,
    };
  }
  return { routeId: "main", modules: [MAIN_MODULE], budgetBytes: DEFAULT_SKILL_BUDGET_BYTES };
}

/** Resolve which skill modules a turn injects. Pure: no filesystem access. */
export function resolveSkillModules(input: ResolveSkillModulesInput): SkillModuleResolution {
  const name = input.skillName.trim().toLowerCase();
  if (name === IMPECCABLE_SKILL_NAME) return resolveImpeccableModules(input);
  if (name === DESIGN_INTELLIGENCE_SKILL_NAME) return resolveDesignIntelligenceModules(input);
  return { routeId: "main", modules: [MAIN_MODULE], budgetBytes: DEFAULT_SKILL_BUDGET_BYTES };
}
