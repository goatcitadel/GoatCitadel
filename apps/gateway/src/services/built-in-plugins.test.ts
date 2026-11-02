import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillCategoryFor } from "@goatcitadel/contracts";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import {
  builtInPluginsRoot,
  PACKAGED_BUILT_IN_PLUGINS_FOLDER,
  UNVERIFIED_APP_FOLDER_MESSAGE,
} from "./built-in-plugins-root.js";
import {
  listBuiltInPluginManifests,
  readPluginManifestFile,
  reservedPluginIds,
  SHIPPED_PLUGIN_IDS,
} from "./plugin-manifest-file.js";
import { fetchPluginSource } from "./plugin-source-service.js";
import { prepareVerificationRuntime } from "../../../../scripts/verification/lib/runtime.mjs";
import { prepareUsabilityRuntime } from "../../../../scripts/verification/lib/scenarios/usability-runtime-fixture.mjs";

/**
 * The plugins that ship with GoatCitadel: every folder under the repository's `plugins/` is a manifest GoatCitadel
 * reads, the release bundle and every fresh-install fixture carry the folder, and a packaged install reads it from its
 * own app folder, or reads none when that folder can't be verified, never from the writable runtime root.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

describe("the plugins that ship with GoatCitadel", () => {
  it("parses every shipped plugin manifest", async () => {
    const entries = fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true });
    // Only plain folders ship, beside the README: the list skips a link, though a built-in fetch would follow one.
    expect(
      entries
        .filter((entry) => entry.name !== "README.md" && (entry.isSymbolicLink() || !entry.isDirectory()))
        .map((entry) => entry.name),
    ).toEqual([]);
    const folders = entries
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
    // Every shipped folder is listed: none is left out for a manifest the list can't read.
    expect((await listBuiltInPluginManifests(PLUGINS_ROOT)).map((manifest) => manifest.pluginId)).toEqual(folders);
    // The fixed list that keeps these ids reserved while the folder can't be read names exactly the shipped folders.
    expect([...SHIPPED_PLUGIN_IDS].sort()).toEqual(folders);
  });

  it("reserves every shipped id even when the built-in folder can't be read", async () => {
    // No folder (a packaged install whose app folder can't be verified): a Git or folder plugin still can't take one.
    expect(reservedPluginIds(await listBuiltInPluginManifests(undefined))).toEqual([...SHIPPED_PLUGIN_IDS]);
    // A readable folder adds its own ids, once each.
    const listed = await listBuiltInPluginManifests(PLUGINS_ROOT);
    expect(reservedPluginIds([...listed, ...listed]).sort()).toEqual([...SHIPPED_PLUGIN_IDS].sort());
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

  it("packages the plugins folder", async () => {
    // The release bundle copies the folder into the app's read-only templates, where the packaged Gateway reads it.
    const bundle = readRepoFile("scripts/packaging/build-bundle.mjs");
    expect(bundle).toContain('const templatesRoot = path.join(appRoot, "templates");');
    expect(PACKAGED_BUILT_IN_PLUGINS_FOLDER).toEqual(["templates", "plugins"]);
    expect(bundle).toContain('copyIfExists(path.join(repoRoot, "plugins"), path.join(templatesRoot, "plugins"));');
    // The launcher never seeds them into the writable runtime root, so nothing placed there reads as built in.
    const launcher = readRepoFile("bin/goatcitadel.mjs");
    expect(launcher).not.toMatch(/packagedRuntimeRoot, "plugins"/u);

    // The fresh-install fixtures the verification lanes and the usability proof start from, run for real: each runtime
    // root they make holds the shipped plugins.
    const shipped = path.join("plugins", "browser-checks", "goatcitadel-plugin.json");
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-fixtures-"));
    const previousTempRoot = process.env.GOATCITADEL_VERIFY_TEMP_ROOT;
    process.env.GOATCITADEL_VERIFY_TEMP_ROOT = tempParent;
    try {
      const verification: string = await prepareVerificationRuntime("built-in-plugins-test");
      expect(fs.existsSync(path.join(verification, shipped))).toBe(true);
      const usability: string = await prepareUsabilityRuntime("built-in-plugins-test", "http://127.0.0.1:9", {
        tempParent,
      });
      expect(fs.existsSync(path.join(usability, shipped))).toBe(true);
    } finally {
      if (previousTempRoot === undefined) delete process.env.GOATCITADEL_VERIFY_TEMP_ROOT;
      else process.env.GOATCITADEL_VERIFY_TEMP_ROOT = previousTempRoot;
      fs.rmSync(tempParent, { recursive: true, force: true });
    }
    // The test bench and the screenshot gallery copy only git-tracked files from inside their own runs, and the bundle
    // runs as one whole script, so those are read as written.
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

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * A release bundle's layout, as `resolvePackagedRuntimeAppDir` accepts it, and the writable runtime root beside it
   * with a plugin folder dropped in, which must never read as built in.
   */
  function packagedInstall() {
    const home = tempDir("goatcitadel-built-in-plugins-");
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
    return { home, appDir, runtimeRoot, runtimePaths };
  }

  /** A Gateway run from a source checkout (with a system Node), as `pnpm dev:gateway` runs one. */
  function sourceCheckout() {
    const checkout = tempDir("goatcitadel-checkout-");
    fs.writeFileSync(path.join(checkout, "pnpm-workspace.yaml"), "packages: []\n");
    fs.mkdirSync(path.join(checkout, "bin"));
    fs.writeFileSync(path.join(checkout, "bin", "goatcitadel.mjs"), "\n");
    const runtimePaths = {
      gatewayModulePath: path.join(checkout, "apps", "gateway", "src", "services", "built-in-plugins-root.ts"),
      entryPath: path.join(checkout, "apps", "gateway", "src", "main.ts"),
      executablePath: process.execPath,
    };
    return { checkout, runtimePaths };
  }

  it("reads a packaged release's own app folder, never the writable runtime root", () => {
    const { appDir, runtimeRoot, runtimePaths } = packagedInstall();
    const report = vi.fn();

    expect(builtInPluginsRoot(runtimeRoot, { appDirVariable: appDir, otherCandidates: [], runtimePaths }, report)).toBe(
      path.join(appDir, "templates", "plugins"),
    );
    // The launcher starts the packaged Gateway in `app/gateway`, so the app folder is found without the variable too.
    expect(
      builtInPluginsRoot(
        runtimeRoot,
        { appDirVariable: undefined, otherCandidates: [path.join(appDir, "gateway"), appDir], runtimePaths },
        report,
      ),
    ).toBe(path.join(appDir, "templates", "plugins"));
    expect(report).not.toHaveBeenCalled();
  });

  it("finds a packaged release from this Gateway's own module when it is started without the launcher", () => {
    const { appDir, runtimeRoot, runtimePaths } = packagedInstall();
    const elsewhere = tempDir("goatcitadel-elsewhere-");
    const report = vi.fn();
    // `node <home>/app/gateway/dist/main.js` from another folder, with no GOATCITADEL_APP_DIR.
    const manual = { appDirVariable: undefined, otherCandidates: [elsewhere, runtimeRoot], runtimePaths };

    expect(builtInPluginsRoot(runtimeRoot, manual, report)).toBe(path.join(appDir, "templates", "plugins"));

    // The same start on a Node outside the release: its app folder can't be verified, so none is read as built in.
    const systemNode = { ...runtimePaths, executablePath: sourceCheckout().runtimePaths.executablePath };
    expect(builtInPluginsRoot(runtimeRoot, { ...manual, runtimePaths: systemNode }, report)).toBeUndefined();
    expect(report.mock.calls).toEqual([[UNVERIFIED_APP_FOLDER_MESSAGE]]);
  });

  it("reads no built-ins when a packaged install's app folder can't be verified, never the runtime root", async () => {
    const { home, appDir, runtimeRoot, runtimePaths } = packagedInstall();
    const systemNode = sourceCheckout().runtimePaths;
    const report = vi.fn();
    const unverified = [
      // The launcher names the release, but this Gateway runs on another Node, outside it.
      { appDirVariable: appDir, otherCandidates: [], runtimePaths: systemNode },
      // The Gateway's working folder sits in a release it doesn't run from.
      { appDirVariable: undefined, otherCandidates: [path.join(appDir, "gateway"), appDir], runtimePaths: systemNode },
    ];
    for (const discovery of unverified) expect(builtInPluginsRoot(runtimeRoot, discovery, report)).toBeUndefined();
    // The launcher names a folder that holds this Gateway but no release manifest, and isn't a source checkout.
    fs.rmSync(path.join(appDir, "release-manifest.json"));
    expect(
      builtInPluginsRoot(runtimeRoot, { appDirVariable: appDir, otherCandidates: [], runtimePaths }, report),
    ).toBeUndefined();

    expect(fs.existsSync(path.join(runtimeRoot, "plugins", "dropped-here"))).toBe(true);
    // One plain line each time, naming no folder.
    expect(report.mock.calls).toEqual([
      [UNVERIFIED_APP_FOLDER_MESSAGE],
      [UNVERIFIED_APP_FOLDER_MESSAGE],
      [UNVERIFIED_APP_FOLDER_MESSAGE],
    ]);
    expect(UNVERIFIED_APP_FOLDER_MESSAGE).not.toMatch(/[\\/]/u);
    expect(UNVERIFIED_APP_FOLDER_MESSAGE).not.toContain(home);

    // With no folder, nothing is listed and a built-in fetch is the usual "not shipped", with nothing copied.
    expect(await listBuiltInPluginManifests(undefined)).toEqual([]);
    const importSnapshot = vi.fn();
    await expect(
      fetchPluginSource(
        { kind: "built_in", pluginId: "dropped-here" },
        { importSnapshot, builtInRoot: undefined, deploymentProfile: "trusted_local", tempRoot: home },
      ),
    ).rejects.toMatchObject({ statusCode: 404, reason: "BUILT_IN_NOT_FOUND" });
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  it("reads <rootDir>/plugins in a checkout or the Docker image, even when the variable names the checkout", () => {
    const { checkout, runtimePaths } = sourceCheckout();
    const report = vi.fn();

    expect(
      builtInPluginsRoot(
        checkout,
        {
          appDirVariable: undefined,
          otherCandidates: [path.join(checkout, "apps", "gateway"), checkout],
          runtimePaths,
        },
        report,
      ),
    ).toBe(path.join(checkout, "plugins"));
    // `verify:desktop` runs the launcher with GOATCITADEL_APP_DIR set to the checkout itself.
    expect(builtInPluginsRoot(checkout, { appDirVariable: checkout, otherCandidates: [], runtimePaths }, report)).toBe(
      path.join(checkout, "plugins"),
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("reads this repository's plugins folder from this checkout", () => {
    // An explicit discovery, so the runner's own GOATCITADEL_APP_DIR and working folder change nothing.
    const discovery = {
      appDirVariable: undefined,
      otherCandidates: [path.join(REPO_ROOT, "apps", "gateway"), REPO_ROOT],
      runtimePaths: {
        gatewayModulePath: path.join(REPO_ROOT, "apps", "gateway", "src", "services", "built-in-plugins-root.ts"),
        entryPath: path.join(REPO_ROOT, "apps", "gateway", "src", "main.ts"),
        executablePath: process.execPath,
      },
    };
    const report = vi.fn();

    expect(builtInPluginsRoot(REPO_ROOT, discovery, report)).toBe(PLUGINS_ROOT);
    // The launcher's `verify:desktop` run names the checkout itself, which reads the same folder.
    expect(builtInPluginsRoot(REPO_ROOT, { ...discovery, appDirVariable: REPO_ROOT }, report)).toBe(PLUGINS_ROOT);
    expect(report).not.toHaveBeenCalled();
  });
});
