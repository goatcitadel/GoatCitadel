import { execFileSync } from "node:child_process";
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

describe("SkillImportService loop42 git install behavior", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-loop42-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it(
    "rejects local git transport instead of weakening the HTTPS-only clone boundary",
    { timeout: 120_000 },
    async () => {
      const repoDir = createGitSkillRepo(rootDir);
      const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

      await expect(
        service.installImport({
          sourceRef: repoDir,
          sourceType: "git_url",
          sourceProvider: "github",
        }),
      ).rejects.toThrow("Failed to clone git source");
      expect(fs.existsSync(path.join(rootDir, "skills", "extra", "git-runtime-tool"))).toBe(false);
      expect(service.listHistory(1)).toEqual([
        expect.objectContaining({
          action: "install",
          outcome: "failed",
          sourceProvider: "github",
          sourceType: "git_url",
          sourceRef: repoDir,
          details: expect.objectContaining({
            error: expect.stringContaining("Failed to clone git source"),
          }),
        }),
      ]);
    },
  );
});

function createGitSkillRepo(rootDir: string): string {
  const repoDir = path.join(rootDir, "git-runtime-tool-source");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "SKILL.md"),
    [
      "---",
      "name: Git Runtime Tool",
      "description: Validate git-backed skill installation metadata behavior.",
      "---",
      "",
      "Use this git skill fixture to validate source revision metadata.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "LICENSE"), "MIT\n", "utf8");
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["add", "SKILL.md", "LICENSE"], { cwd: repoDir, stdio: "ignore", windowsHide: true });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=GoatCitadel Test",
      "-c",
      "user.email=goatcitadel-test@example.invalid",
      "commit",
      "-m",
      "Initial skill fixture",
    ],
    { cwd: repoDir, stdio: "ignore", windowsHide: true },
  );
  return repoDir;
}
