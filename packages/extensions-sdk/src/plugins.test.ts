import { createHash } from "node:crypto";
import fs from "node:fs";
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginManifestTooLarge } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS, PLUGIN_MANIFEST_FILENAME, loadPluginManifest, parsePluginManifest } from "./plugins.js";

// Every call passes through to the real module. One test replaces one call, once, to play out a file that grows
// between the size check and the read.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

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

  it("gives the same too-large refusal as parsePluginManifest", async () => {
    writeManifest(Buffer.alloc(PLUGIN_LIMITS.maxManifestBytes + 1, 0x20));
    const result = await loadPluginManifest(workDir);
    expect(result).toEqual(pluginManifestTooLarge());
    expect(parsePluginManifest(" ".repeat(PLUGIN_LIMITS.maxManifestBytes + 1))).toEqual(result);
  });

  describe("when the file grows after its size was checked", () => {
    /** 64 KiB of spaces and then a two-byte character, so a cut at the cap lands inside the character. */
    function writeGrowingManifest(): string {
      return writeManifest(
        Buffer.concat([Buffer.alloc(PLUGIN_LIMITS.maxManifestBytes, 0x20), Buffer.from("é", "utf8")]),
      );
    }

    /** Make the next `lstat` report a 10-byte file, as it would if the file were small when measured. */
    async function reportSmallSizeOnce(file: string): Promise<void> {
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const real = await actualFs.lstat(file);
      vi.mocked(lstat).mockResolvedValueOnce(Object.assign(Object.create(real) as typeof real, { size: 10 }));
    }

    /** Count the bytes the next opened file hands back. */
    async function countBytesReadOnce(): Promise<() => number> {
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let total = 0;
      vi.mocked(open).mockImplementationOnce((async (...args: Parameters<typeof actualFs.open>) => {
        const handle = await actualFs.open(...args);
        const read = handle.read.bind(handle) as unknown as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        handle.read = (async (...a: unknown[]) => {
          const result = await read(...a);
          total += result.bytesRead;
          return result;
        }) as typeof handle.read;
        return handle;
      }) as typeof open);
      return () => total;
    }

    it("reads no more than 64 KiB plus one byte and answers MANIFEST_TOO_LARGE", async () => {
      const file = writeGrowingManifest();
      await reportSmallSizeOnce(file);
      const bytesRead = await countBytesReadOnce();
      const result = await loadPluginManifest(workDir);
      expect(bytesRead()).toBe(PLUGIN_LIMITS.maxManifestBytes + 1);
      // The cut falls inside the two-byte character. Only the byte count after the read can say "too large" here;
      // decoding the cut text would say "not UTF-8".
      expect(result).toEqual(pluginManifestTooLarge());
    });
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
