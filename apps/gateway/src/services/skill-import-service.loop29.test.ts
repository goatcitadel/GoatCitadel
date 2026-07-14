import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillImportService } from "./skill-import-service.js";

describe("SkillImportService loop 29 runtime behavior", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-loop29-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records failed validation history when the source cannot be materialized", async () => {
    const missingSource = path.join(rootDir, "missing-skill");
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    await expect(
      service.validateImport({
        sourceRef: missingSource,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(/Local source path is not a directory/);

    expect(service.listHistory(1)).toEqual([
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceProvider: "local",
        sourceType: "local_path",
        sourceRef: missingSource,
        details: expect.objectContaining({
          error: expect.stringContaining("Local source path is not a directory"),
        }),
      }),
    ]);
  });

  it("force-overwrites an existing install only after validation succeeds and records accepted history", async () => {
    const sourceDir = path.join(rootDir, "safe-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "SKILL.md"),
      [
        "---",
        "name: Safe Skill",
        "description: A safe local skill fixture for install overwrite coverage.",
        "---",
        "",
        "Use this skill for safe deterministic local workflows.",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "LICENSE"), "MIT\n", "utf8");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const firstInstall = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    fs.writeFileSync(path.join(firstInstall.installedPath, "stale.txt"), "stale", "utf8");

    await expect(
      service.installImport({
        sourceRef: sourceDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(/Skill install target already exists/);

    const originalRename = fsPromises.rename.bind(fsPromises);
    let extraDirectoriesDuringSwap: string[] | undefined;
    let replacementBackupPath: string | undefined;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (oldPath, newPath) => {
      await originalRename(oldPath, newPath);
      if (path.resolve(String(oldPath)) === path.resolve(firstInstall.installedPath)) {
        replacementBackupPath = String(newPath);
        extraDirectoriesDuringSwap = fs
          .readdirSync(path.join(rootDir, "skills", "extra"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      }
    });

    const secondInstall = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
      force: true,
    });
    const manifest = JSON.parse(fs.readFileSync(secondInstall.sourceManifestPath, "utf8")) as Record<string, unknown>;

    expect(secondInstall.installedPath).toBe(firstInstall.installedPath);
    expect(replacementBackupPath).toContain(`${path.sep}skills${path.sep}.import-staging${path.sep}replaced-`);
    expect(extraDirectoriesDuringSwap).toEqual([]);
    expect(fs.existsSync(path.join(secondInstall.installedPath, "stale.txt"))).toBe(false);
    expect(manifest).toMatchObject({
      manifestVersion: 3,
      riskLevel: "low",
    });
    expect(service.listHistory(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "install",
          outcome: "accepted",
          skillId: "safe-skill",
          details: expect.objectContaining({ installedPath: "skills/extra/safe-skill" }),
        }),
        expect.objectContaining({
          action: "install",
          outcome: "failed",
          details: expect.objectContaining({
            error: expect.stringContaining("Skill install target already exists"),
          }),
        }),
      ]),
    );
  });

  it("keeps the verified replacement live when cleanup leaves a partially removed quarantined backup", async () => {
    const sourceDir = path.join(rootDir, "cleanup-race-skill");
    writeSkillSource(sourceDir, "Use version one of this deterministic skill.");
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const firstInstall = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    writeSkillSource(sourceDir, "Use version two of this verified deterministic skill.");
    const originalRm = fsPromises.rm.bind(fsPromises);
    let quarantinedBackupPath: string | undefined;
    vi.spyOn(fsPromises, "rm").mockImplementation(async (targetPath, options) => {
      const target = String(targetPath);
      if (target.includes(`${path.sep}.import-staging${path.sep}replaced-`)) {
        quarantinedBackupPath = target;
        await originalRm(path.join(target, "SKILL.md"), { force: true });
        throw new Error("simulated partial replacement-backup cleanup");
      }
      await originalRm(targetPath, options);
    });

    const replacement = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
      force: true,
    });

    expect(replacement.installedPath).toBe(firstInstall.installedPath);
    expect(fs.readFileSync(path.join(replacement.installedPath, "SKILL.md"), "utf8")).toContain("version two");
    expect(quarantinedBackupPath).toBeDefined();
    expect(fs.existsSync(path.join(quarantinedBackupPath!, "SKILL.md"))).toBe(false);
    expect(
      fs
        .readdirSync(path.join(rootDir, "skills", "extra"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ).toEqual(["cleanup-race-skill"]);
    expect(replacement.validation.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("non-loadable quarantined backup")]),
    );
    expect(service.listHistory(1)[0]).toMatchObject({
      action: "install",
      outcome: "accepted",
      details: {
        replacementCleanupWarning: expect.stringContaining("non-loadable quarantined backup"),
      },
    });
  });
});

function writeSkillSource(sourceDir: string, instruction: string): void {
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "SKILL.md"),
    [
      "---",
      `name: ${path.basename(sourceDir)}`,
      "description: A safe local skill fixture for exact-byte replacement coverage.",
      "---",
      "",
      instruction,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(sourceDir, "LICENSE"), "MIT\n", "utf8");
}

function createSystemSettingsRepo() {
  const values = new Map<string, { value: unknown }>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, { value });
    },
  };
}
