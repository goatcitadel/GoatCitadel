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
 */
const PLUGIN_SKILL_TOKEN = /\bpluginSkill\b/u;
const REVIEW_SERVICE = "apps/gateway/src/services/skill-hub-review-service.ts";
const ALLOWED_FILES = new Set([
  REVIEW_SERVICE,
  "apps/gateway/src/services/skill-hub-plugin-skill-source.ts",
  "apps/gateway/src/services/capability-plugin-inspection-service.ts",
]);
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

  it("finds pluginSkill only in the review and in the plugin inspection service", () => {
    const inventory = readInventory();
    // The walk really reached the file that defines the input, and the routes that must never carry it.
    const review = inventory.find((file) => file.relativePath === REVIEW_SERVICE);
    expect(PLUGIN_SKILL_TOKEN.test(review?.content ?? "")).toBe(true);
    expect(inventory.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["apps/gateway/src/routes/skills.ts", "apps/gateway/src/routes/capability-skills.ts"]),
    );
    expect(() => assertPluginSkillOnlyFromOwners(inventory)).not.toThrow();
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
});

function assertPluginSkillOnlyFromOwners(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => PLUGIN_SKILL_TOKEN.test(file.content) && !ALLOWED_FILES.has(file.relativePath))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`pluginSkill is named outside its owners: ${offenders.join(", ")}`);
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
