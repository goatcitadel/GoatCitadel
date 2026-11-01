import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { skillCategoryFor } from "@goatcitadel/contracts";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { builtInPluginsRoot, PACKAGED_BUILT_IN_PLUGINS_FOLDER } from "./built-in-plugins-root.js";
import { listBuiltInPluginManifests, readPluginManifestFile } from "./plugin-manifest-file.js";

/**
 * The plugins that ship with GoatCitadel: every folder under the repository's `plugins/` is a manifest GoatCitadel
 * reads, the release bundle and every fresh-install fixture carry the folder, and a packaged install reads it from its
 * own app folder, never from the writable runtime root.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

describe("the plugins that ship with GoatCitadel", () => {
  it("parses every shipped plugin manifest", async () => {
    const folders = fs
      .readdirSync(PLUGINS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toContain("browser-checks");

    for (const folder of folders) {
      const parsed = await readPluginManifestFile(path.join(PLUGINS_ROOT, folder));
      expect(parsed, folder).toMatchObject({ ok: true });
      if (!parsed.ok) continue;
      // The list keeps a folder only when its manifest names that same id, so a mismatch would drop it unseen.
      expect(parsed.manifest.pluginId).toBe(folder);
      for (const piece of parsed.manifest.pieces) {
        if (piece.kind === "skill") {
          expect(fs.statSync(path.join(PLUGINS_ROOT, folder, piece.path, "SKILL.md")).isFile(), piece.id).toBe(true);
        }
        if (piece.kind === "prompt_pack") {
          expect(fs.statSync(path.join(PLUGINS_ROOT, folder, piece.path)).isFile(), piece.id).toBe(true);
        }
      }
    }
    // Every shipped folder is listed: none is a link, and none is left out for a manifest the list can't read.
    expect((await listBuiltInPluginManifests(PLUGINS_ROOT)).map((manifest) => manifest.pluginId)).toEqual(folders);
  });

  it("ships Browser checks as one Playwright connector that always asks first, and one skill", async () => {
    const parsed = await readPluginManifestFile(path.join(PLUGINS_ROOT, "browser-checks"));

    expect(parsed.ok && parsed.manifest).toEqual({
      schemaVersion: 1,
      pluginId: "browser-checks",
      name: "Browser checks",
      description:
        "Lets the AI open pages in a private browser, read them and take screenshots, with a skill for checking web pages step by step.",
      version: "1.0.0",
      author: "GoatCitadel",
      pieces: [
        { kind: "connector", id: "playwright", templateId: "playwright", asksFirst: "everything" },
        { kind: "skill", id: "browser-qa", path: "skills/browser-qa" },
      ],
    });
  });

  it("gives Browser checks' skill the frontmatter GoatCitadel's checks accept, in the Coding category", () => {
    const markdown = readRepoFile("plugins/browser-checks/skills/browser-qa/SKILL.md");
    const { frontmatter, body } = parseSkillMarkdown(markdown);

    // The Skill Hub refuses any other top-level or metadata key, and maps every declared tool to a governed one.
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "metadata", "name"]);
    expect(Object.keys(frontmatter.metadata ?? {}).sort()).toEqual(["keywords", "tags", "tools", "version"]);
    // The name the 4d fixtures and the installed id (`extra:browser-qa`) assume, never the old pack's
    // `browser-qa-operator`, which an install that once ran the pack may already hold.
    expect(frontmatter.name).toBe("browser-qa");
    expect(frontmatter.description.split(/\s+/u).length).toBeGreaterThanOrEqual(4);
    expect(frontmatter.metadata?.tools).toEqual([]);
    expect(
      skillCategoryFor({
        skillId: `extra:${frontmatter.name}`,
        tags: frontmatter.metadata?.tags,
        keywords: frontmatter.metadata?.keywords,
      }),
    ).toBe("coding");
    for (const section of ["## When to use", "## Instructions", "## Failure handling", "## Boundaries"]) {
      expect(body).toContain(section);
    }
  });

  it("packages the plugins folder", () => {
    // The release bundle copies the folder into the app's read-only templates, where the packaged Gateway reads it.
    const bundle = readRepoFile("scripts/packaging/build-bundle.mjs");
    expect(bundle).toContain('const templatesRoot = path.join(appRoot, "templates");');
    expect(PACKAGED_BUILT_IN_PLUGINS_FOLDER).toEqual(["templates", "plugins"]);
    expect(bundle).toContain('copyIfExists(path.join(repoRoot, "plugins"), path.join(templatesRoot, "plugins"));');
    // The launcher never seeds them into the writable runtime root, so nothing placed there reads as built in.
    const launcher = readRepoFile("bin/goatcitadel.mjs");
    expect(launcher).not.toMatch(/packagedRuntimeRoot, "plugins"/u);

    // Every fresh-install fixture the verification lanes, the test bench and the screenshot gallery start from.
    expect(readRepoFile("scripts/verification/lib/runtime.mjs")).toMatch(
      /for \(const folder of \["skills", "plugins", "workspaces"\]\)/u,
    );
    expect(readRepoFile("scripts/verification/lib/scenarios/usability-runtime-fixture.mjs")).toMatch(
      /for \(const folder of \["skills", "plugins"\]\)/u,
    );
    expect(readRepoFile("scripts/testbench-runtime.mjs")).toMatch(
      /const SHIPPED_TRACKED_FOLDERS = \["skills", "plugins"\];/u,
    );
    expect(readRepoFile("packages/policy-engine/scripts/capture-mission-control-screenshots.mjs")).toMatch(
      /"ls-files", "-z", "--", "skills", "plugins"\]/u,
    );
  });
});

describe("where the Gateway reads the plugins that ship", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A release bundle's layout, as `resolvePackagedRuntimeAppDir` accepts it, plus a writable runtime root beside it. */
  function packagedInstall() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-built-in-plugins-"));
    tempDirs.push(home);
    const appDir = path.join(home, "app");
    const files = {
      manifest: path.join(appDir, "release-manifest.json"),
      entry: path.join(appDir, "gateway", "dist", "main.js"),
      module: path.join(appDir, "gateway", "dist", "services", "built-in-plugins-root.js"),
      node: path.join(appDir, "runtime", "node", "node.exe"),
    };
    for (const file of Object.values(files)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}\n");
    }
    const runtimeRoot = path.join(home, "runtime-root");
    fs.mkdirSync(path.join(runtimeRoot, "plugins", "dropped-here"), { recursive: true });
    const runtimePaths = { gatewayModulePath: files.module, entryPath: files.entry, executablePath: files.node };
    return { appDir, runtimeRoot, runtimePaths };
  }

  it("reads a packaged release's own app folder, never the writable runtime root", () => {
    const { appDir, runtimeRoot, runtimePaths } = packagedInstall();

    expect(builtInPluginsRoot(runtimeRoot, { candidates: [appDir], runtimePaths })).toBe(
      path.join(appDir, "templates", "plugins"),
    );
    // The launcher starts the packaged Gateway in `app/gateway`, so the app folder is found without the variable too.
    expect(
      builtInPluginsRoot(runtimeRoot, {
        candidates: [undefined, path.join(appDir, "gateway"), appDir],
        runtimePaths,
      }),
    ).toBe(path.join(appDir, "templates", "plugins"));
  });

  it("reads <rootDir>/plugins in a checkout, and when the named app folder isn't this Gateway's release", () => {
    const { appDir, runtimeRoot, runtimePaths } = packagedInstall();
    const checkout = path.join(os.tmpdir(), "goatcitadel-checkout");
    const elsewhere = {
      gatewayModulePath: path.join(checkout, "apps", "gateway", "src", "services", "built-in-plugins-root.ts"),
      entryPath: path.join(checkout, "apps", "gateway", "src", "main.ts"),
      executablePath: process.execPath,
    };

    expect(builtInPluginsRoot(checkout, { candidates: [undefined], runtimePaths: elsewhere })).toBe(
      path.join(checkout, "plugins"),
    );
    // A release folder that doesn't hold the running Gateway lends it nothing.
    expect(builtInPluginsRoot(runtimeRoot, { candidates: [appDir], runtimePaths: elsewhere })).toBe(
      path.join(runtimeRoot, "plugins"),
    );
    // So does a folder that holds the running Gateway but no release manifest.
    fs.rmSync(path.join(appDir, "release-manifest.json"));
    expect(builtInPluginsRoot(runtimeRoot, { candidates: [appDir], runtimePaths })).toBe(
      path.join(runtimeRoot, "plugins"),
    );
  });

  it("reads this repository's plugins folder from this checkout", () => {
    expect(builtInPluginsRoot(REPO_ROOT)).toBe(PLUGINS_ROOT);
  });
});
