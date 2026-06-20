import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillImportService } from "./skill-import-service.js";

function createSystemSettingsRepo() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      if (!store.has(key)) {
        return undefined;
      }
      return { value: store.get(key) as T };
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

describe("SkillImportService loop41 zip install behavior", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-loop41-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("installs local zip bundles, rejects duplicate targets, and force-reinstalls cleanly", async () => {
    const firstZip = createSkillZip(rootDir, "zip-runtime-tool-a.zip");
    const secondZip = createSkillZip(rootDir, "zip-runtime-tool-b.zip");
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    const firstInstall = await service.installImport({
      sourceRef: firstZip,
      sourceType: "local_zip",
      sourceProvider: "local",
    });
    const staleFile = path.join(firstInstall.installedPath, "STALE.txt");
    fs.writeFileSync(staleFile, "old install residue", "utf8");

    await expect(
      service.installImport({
        sourceRef: secondZip,
        sourceType: "local_zip",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(/Skill install target already exists/);

    const forcedInstall = await service.installImport({
      sourceRef: secondZip,
      sourceType: "local_zip",
      sourceProvider: "local",
      force: true,
    });
    const manifest = JSON.parse(fs.readFileSync(forcedInstall.sourceManifestPath, "utf8")) as Record<string, unknown>;
    const lookup = await service.lookupSources(secondZip, 5);

    expect(forcedInstall.installedPath).toBe(firstInstall.installedPath);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(path.join(forcedInstall.installedPath, "SKILL.md"))).toBe(true);
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      riskLevel: "low",
      candidate: expect.objectContaining({
        sourceProvider: "local",
        sourceType: "local_zip",
        sourceRef: secondZip,
      }),
      resolvedUpstream: {
        url: secondZip,
      },
    });
    expect(lookup.bestMatch).toMatchObject({
      sourceProvider: "local",
      installability: "direct",
    });
    expect(service.listHistory(3)).toEqual([
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        sourceRef: secondZip,
        details: expect.objectContaining({ installedPath: "skills/extra/zip-runtime-tool" }),
      }),
      expect.objectContaining({
        action: "install",
        outcome: "failed",
        sourceRef: secondZip,
        details: expect.objectContaining({
          error: expect.stringContaining("Skill install target already exists"),
        }),
      }),
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        sourceRef: firstZip,
      }),
    ]);
    // Real zip pack/unpack + force-reinstall over the filesystem is genuinely slow;
    // under v8 coverage instrumentation in a loaded parallel run it can exceed the
    // default 15s budget, so give this I/O-heavy case explicit headroom.
  }, 30_000);
});

function createSkillZip(rootDir: string, fileName: string): string {
  const sourceRoot = path.join(rootDir, `${fileName}-source`);
  const skillDir = path.join(sourceRoot, "nested", "zip-runtime-tool");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: Zip Runtime Tool",
      "description: Validate zipped runtime skill installation metadata behavior.",
      "---",
      "",
      "Use this zipped skill fixture to validate install cleanup and metadata handling.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n", "utf8");
  const zipPath = path.join(rootDir, fileName);
  const zip = new AdmZip();
  zip.addLocalFolder(sourceRoot, "bundle");
  zip.writeZip(zipPath);
  return zipPath;
}
