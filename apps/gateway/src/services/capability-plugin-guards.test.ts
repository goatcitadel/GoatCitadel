import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A plugin's skill is reviewed by the Skill Hub on a snapshot folder the Gateway already holds, and the review records
 * the plugin as the source. That is only honest when the folder and the plugin's identity come from the Gateway's own
 * plugin check, never from a request. So `pluginSkill` may be named in three production files only: the review (the input
 * type and its own handling), the helper beside it that checks the input and names it in its refusals, and the plugin
 * inspection service, which reads the plugin's manifest and is the one caller.
 * A route schema, a route service, Chat or any other service that names it could hand the review a folder and a trust
 * level of its choosing, so this guard fails on it.
 *
 * The helper beside the review is the review's own: only the review imports it, and the inspection service may import
 * its input type (`import type`) so it can build one, never its functions.
 */
const PLUGIN_SKILL_TOKEN = /\bpluginSkill\b/u;
const REVIEW_SERVICE = "apps/gateway/src/services/skill-hub-review-service.ts";
const SOURCE_HELPER = "apps/gateway/src/services/skill-hub-plugin-skill-source.ts";
// Task 13 creates the inspection service. It is allowed here already, and is expected to appear with that task.
const INSPECTION_SERVICE = "apps/gateway/src/services/capability-plugin-inspection-service.ts";
const ALLOWED_FILES = new Set([REVIEW_SERVICE, SOURCE_HELPER, INSPECTION_SERVICE]);
const HELPER_SPECIFIER = "skill-hub-plugin-skill-source";
const HELPER_TYPE_IMPORT = /\bimport\s+type\s+[^;]*?\bfrom\s+["'][^"']*\/skill-hub-plugin-skill-source(?:\.js)?["']/gu;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

interface SourceFile {
  relativePath: string;
  content: string;
}

describe("plugin skill review guard", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const readInventory = (): SourceFile[] =>
    listProductionSources(resolve(repoRoot, "apps", "gateway", "src")).map((filePath) => ({
      relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
      content: readFileSync(filePath, "utf8"),
    }));

  it("finds pluginSkill only in the review, its helper and the plugin inspection service", () => {
    const inventory = readInventory();
    // The walk really reached the files that define the input, and the routes that must never carry it.
    const paths = inventory.map((file) => file.relativePath);
    for (const owner of ALLOWED_FILES) {
      if (owner !== INSPECTION_SERVICE) expect(paths, owner).toContain(owner);
    }
    const review = inventory.find((file) => file.relativePath === REVIEW_SERVICE);
    expect(PLUGIN_SKILL_TOKEN.test(review?.content ?? "")).toBe(true);
    expect(paths).toEqual(
      expect.arrayContaining(["apps/gateway/src/routes/skills.ts", "apps/gateway/src/routes/capability-skills.ts"]),
    );
    expect(() => assertPluginSkillOnlyFromOwners(inventory)).not.toThrow();
  });

  it("lets only the review import the helper, and the inspection service only its types", () => {
    const inventory = readInventory();
    const review = inventory.find((file) => file.relativePath === REVIEW_SERVICE);
    // The review really imports it, so a rename of the helper cannot leave this guard looking at nothing.
    expect(review?.content).toContain(HELPER_SPECIFIER);
    expect(() => assertHelperImportedOnlyByReview(inventory)).not.toThrow();
  });

  it("names the offending file when a route, a route service or anything else carries pluginSkill", () => {
    const leaked: SourceFile[] = [
      { relativePath: REVIEW_SERVICE, content: "pluginSkill?: PluginSkill;" },
      {
        relativePath: "apps/gateway/src/services/capability-plugin-inspection-service.ts",
        content: "reviewSource({ pluginSkill: skill })",
      },
      {
        relativePath: "apps/gateway/src/routes/skills.ts",
        content: "const body = z.object({ pluginSkill: z.any() });",
      },
      {
        relativePath: "apps/gateway/src/services/skills-route-service.ts",
        content: "reviewSource({ ...input, pluginSkill })",
      },
    ];
    expect(() => assertPluginSkillOnlyFromOwners(leaked)).toThrow(
      "pluginSkill is named outside its owners: apps/gateway/src/routes/skills.ts, apps/gateway/src/services/skills-route-service.ts",
    );
  });

  it("names the offending file when anything else imports the helper, or the inspection service imports more than a type", () => {
    const typeOnly = 'import type { SkillHubPluginSkillInput } from "./skill-hub-plugin-skill-source.js";';
    const multiLineTypeOnly = [
      "import type {",
      "  SkillHubPluginSkillInput,",
      '} from "./skill-hub-plugin-skill-source.js";',
    ].join("\n");
    expect(() =>
      assertHelperImportedOnlyByReview([
        { relativePath: REVIEW_SERVICE, content: 'import { x } from "./skill-hub-plugin-skill-source.js";' },
        { relativePath: INSPECTION_SERVICE, content: typeOnly },
        { relativePath: "apps/gateway/src/services/unrelated.ts", content: "export const unrelated = 1;" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertHelperImportedOnlyByReview([{ relativePath: INSPECTION_SERVICE, content: multiLineTypeOnly }]),
    ).not.toThrow();
    expect(() =>
      assertHelperImportedOnlyByReview([
        {
          relativePath: INSPECTION_SERVICE,
          content: [typeOnly, 'import { resolvePluginSkillSource } from "./skill-hub-plugin-skill-source.js";'].join(
            "\n",
          ),
        },
        {
          relativePath: "apps/gateway/src/services/skills-route-service.ts",
          content: 'import { recordedSource } from "./skill-hub-plugin-skill-source.js";',
        },
        {
          relativePath: "apps/gateway/src/routes/skills.ts",
          content: 'const helper = await import("../services/skill-hub-plugin-skill-source.js");',
        },
        {
          relativePath: "apps/gateway/src/services/chat-service.ts",
          content: 'import type { SkillHubPluginSkillInput } from "./skill-hub-plugin-skill-source.js";',
        },
      ]),
    ).toThrow(
      "The plugin skill source helper is imported outside the review: " +
        [
          INSPECTION_SERVICE,
          "apps/gateway/src/services/skills-route-service.ts",
          "apps/gateway/src/routes/skills.ts",
          "apps/gateway/src/services/chat-service.ts",
        ].join(", "),
    );
  });
});

function assertPluginSkillOnlyFromOwners(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => PLUGIN_SKILL_TOKEN.test(file.content) && !ALLOWED_FILES.has(file.relativePath))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`pluginSkill is named outside its owners: ${offenders.join(", ")}`);
  }
}

function assertHelperImportedOnlyByReview(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => {
      if (file.relativePath === SOURCE_HELPER || file.relativePath === REVIEW_SERVICE) return false;
      const rest =
        file.relativePath === INSPECTION_SERVICE ? file.content.replace(HELPER_TYPE_IMPORT, "") : file.content;
      return rest.includes(HELPER_SPECIFIER);
    })
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`The plugin skill source helper is imported outside the review: ${offenders.join(", ")}`);
  }
}

/** Production TypeScript under a directory: no tests, declarations, builds or installed packages. */
function listProductionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".") ? [] : listProductionSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ||
      /\.(test|spec|vitest)\.[cm]?tsx?$/u.test(entry.name) ||
      /\.test-support\.[cm]?tsx?$/u.test(entry.name) ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}
