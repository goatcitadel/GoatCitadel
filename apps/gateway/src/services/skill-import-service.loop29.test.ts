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

    expect(await service.listHistory(1)).toEqual([
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

  // HX-402 P2 (coverage-preserving remodel): the retired executable install
  // can never publish bytes into skills/extra — with or without force — while
  // advisory validation is still returned and history records the redirect.
  it("never publishes bytes for valid local installs and returns the advisory redirect instead", async () => {
    const sourceDir = path.join(rootDir, "safe-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "SKILL.md"),
      [
        "---",
        "name: Safe Skill",
        "description: A safe local skill fixture for install retirement coverage.",
        "---",
        "",
        "Use this skill for safe deterministic local workflows.",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "LICENSE"), "MIT\n", "utf8");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const firstAttempt = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    // Advisory validation still returned in full.
    expect(firstAttempt.validation.valid).toBe(true);
    expect(firstAttempt.validation.inferredSkillId).toBe("safe-skill");
    expect(firstAttempt.disposition).toBe("redirected_to_skill_hub");
    // Local sources cannot become executable through any legacy path.
    expect(firstAttempt.redirect).toMatchObject({
      owner: "skill_hub",
      reviewRoute: "/api/v1/skills/hub/reviews",
      eligible: false,
      ineligibleReason: expect.stringContaining("governed Skill Hub"),
    });
    // ADVERSARIAL: no bytes were published — with or without force.
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
    const forcedAttempt = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
      force: true,
      confirmHighRisk: true,
    });
    expect(forcedAttempt.disposition).toBe("redirected_to_skill_hub");
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
    expect(await service.listHistory(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "install",
          outcome: "accepted",
          skillId: "safe-skill",
          details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
        }),
      ]),
    );
    // No legacy competing lifecycle claim: no installedPath detail exists.
    for (const record of await service.listHistory(10)) {
      expect(record.details?.installedPath).toBeUndefined();
    }
  });

  it("cleans up staging after the redirect so no verified bytes survive outside temp space", async () => {
    const sourceDir = path.join(rootDir, "cleanup-race-skill");
    writeSkillSource(sourceDir, "Use version one of this deterministic skill.");
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const removed: string[] = [];
    const originalRm = fsPromises.rm.bind(fsPromises);
    vi.spyOn(fsPromises, "rm").mockImplementation(async (targetPath, options) => {
      removed.push(String(targetPath));
      await originalRm(targetPath, options);
    });

    const redirected = await service.installImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    expect(redirected.validation.valid).toBe(true);
    // The staged validation copy is removed after the redirect returns.
    const stagingRoot = path.join(rootDir, "skills", ".import-staging");
    expect(removed.some((target) => target.startsWith(stagingRoot))).toBe(true);
    const stagingEntries = fs.existsSync(stagingRoot)
      ? fs.readdirSync(stagingRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    expect(stagingEntries).toEqual([]);
    // And skills/extra was never created at all.
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
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
