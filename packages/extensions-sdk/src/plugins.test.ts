import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_LIMITS, PLUGIN_MANIFEST_FILENAME, loadPluginManifest, parsePluginManifest } from "./plugins.js";

const REFERENCE_PLUGIN_DIR = fileURLToPath(new URL("../templates/plugins/reference-plugin", import.meta.url));

const VALID_MANIFEST = {
  schemaVersion: 1,
  pluginId: "fixture-plugin",
  name: "Fixture plugin",
  description: "A fixture.",
  version: "1.0.0",
  pieces: [{ kind: "skill", id: "notes", path: "skills/notes" }],
};

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manifest-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeManifest(content: string | Buffer): string {
  const file = path.join(workDir, PLUGIN_MANIFEST_FILENAME);
  fs.writeFileSync(file, content);
  return file;
}

/** Whether this machine lets the test create a symbolic link. Windows needs a privilege most accounts lack. */
function canCreateSymlink(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "target"), "x");
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

describe("loadPluginManifest", () => {
  it("loads the reference plugin and every file its pieces name exists", async () => {
    const result = await loadPluginManifest(REFERENCE_PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.pluginId).toBe("reference-plugin");
    for (const piece of result.manifest.pieces) {
      if (piece.kind === "skill") {
        expect(fs.existsSync(path.join(REFERENCE_PLUGIN_DIR, piece.path, "SKILL.md")), piece.id).toBe(true);
      } else if (piece.kind === "prompt_pack") {
        expect(fs.existsSync(path.join(REFERENCE_PLUGIN_DIR, piece.path)), piece.id).toBe(true);
      }
    }
  });

  it("gives the same answer as parsePluginManifest on the file's text", async () => {
    const file = writeManifest(JSON.stringify(VALID_MANIFEST, null, 2));
    const loaded = await loadPluginManifest(workDir);
    expect(loaded).toEqual(parsePluginManifest(fs.readFileSync(file, "utf8")));
    expect(loaded.ok).toBe(true);
  });

  it("hashes the file's bytes as they are, line endings and byte-order mark included", async () => {
    const bytes = Buffer.from(`\uFEFF${JSON.stringify(VALID_MANIFEST, null, 2).replaceAll("\n", "\r\n")}`, "utf8");
    writeManifest(bytes);
    const result = await loadPluginManifest(workDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifestSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("answers MANIFEST_MISSING for a folder with no manifest", async () => {
    expect(await loadPluginManifest(workDir)).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("answers MANIFEST_MISSING for a folder that does not exist", async () => {
    expect(await loadPluginManifest(path.join(workDir, "nowhere"))).toMatchObject({
      ok: false,
      code: "MANIFEST_MISSING",
    });
  });

  it("answers MANIFEST_MISSING when the folder path is a file", async () => {
    const file = path.join(workDir, "plain.txt");
    fs.writeFileSync(file, "x");
    expect(await loadPluginManifest(file)).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("answers MANIFEST_TOO_LARGE for a manifest over 64 KiB, however large the file is", async () => {
    writeManifest(Buffer.alloc(3 * 1024 * 1024, 0x20));
    expect(await loadPluginManifest(workDir)).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });
  });

  it("answers MANIFEST_TOO_LARGE at one byte over the limit, and reads a file of exactly the limit", async () => {
    const json = JSON.stringify(VALID_MANIFEST);
    const exact = `${json}${" ".repeat(PLUGIN_LIMITS.maxManifestBytes - json.length)}`;
    writeManifest(exact);
    expect((await loadPluginManifest(workDir)).ok).toBe(true);
    writeManifest(`${exact} `);
    expect(await loadPluginManifest(workDir)).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });
  });

  it("refuses a manifest that is a folder", async () => {
    fs.mkdirSync(path.join(workDir, PLUGIN_MANIFEST_FILENAME));
    expect(await loadPluginManifest(workDir)).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("refuses bytes that are not UTF-8", async () => {
    writeManifest(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    expect(await loadPluginManifest(workDir)).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("passes a named refusal through", async () => {
    writeManifest(JSON.stringify({ ...VALID_MANIFEST, featureFlags: { x: true } }));
    expect(await loadPluginManifest(workDir)).toMatchObject({
      ok: false,
      code: "FEATURE_FLAGS_NOT_ALLOWED",
      field: "featureFlags",
    });
  });

  it.skipIf(!canCreateSymlink())("refuses a manifest that is a symbolic link", async () => {
    const real = path.join(workDir, "real.json");
    fs.writeFileSync(real, JSON.stringify(VALID_MANIFEST));
    fs.symlinkSync(real, path.join(workDir, PLUGIN_MANIFEST_FILENAME), "file");
    const result = await loadPluginManifest(workDir);
    expect(result).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
    expect(result.ok ? "" : result.message).toMatch(/link/iu);
  });
});
