import fs from "node:fs";
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
    fs.rmSync(rootDir, { recursive: true, force: true });
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

    const secondInstall = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
      force: true,
    });
    const manifest = JSON.parse(fs.readFileSync(secondInstall.sourceManifestPath, "utf8")) as Record<string, unknown>;

    expect(secondInstall.installedPath).toBe(firstInstall.installedPath);
    expect(fs.existsSync(path.join(secondInstall.installedPath, "stale.txt"))).toBe(false);
    expect(manifest).toMatchObject({
      manifestVersion: 2,
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
});

function createSystemSettingsRepo() {
  const values = new Map<string, { value: unknown }>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, { value });
    },
  };
}
