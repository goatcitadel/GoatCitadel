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

  // 120s: spawns real git clone/rev-parse subprocesses; under a loaded machine
  // (verify lanes building concurrently) the global 15s testTimeout is exceeded.
  it(
    "installs local git sources, records resolved HEAD metadata, and cleans cloned materialization",
    { timeout: 120_000 },
    async () => {
      const repoDir = createGitSkillRepo(rootDir);
      const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

      const installed = await service.installImport({
        sourceRef: repoDir,
        sourceType: "git_url",
        sourceProvider: "github",
      });
      const manifest = JSON.parse(fs.readFileSync(installed.sourceManifestPath, "utf8")) as Record<string, unknown>;

      expect(fs.existsSync(path.join(installed.installedPath, "SKILL.md"))).toBe(true);
      expect(manifest).toMatchObject({
        manifestVersion: 2,
        candidate: expect.objectContaining({
          sourceProvider: "github",
          sourceType: "git_url",
          sourceRef: repoDir,
          repositoryUrl: repoDir,
        }),
        resolvedUpstream: {
          url: repoDir,
          ref: "HEAD",
          version: expectedHead,
        },
      });
      expect(service.listHistory(1)).toEqual([
        expect.objectContaining({
          action: "install",
          outcome: "accepted",
          sourceProvider: "github",
          sourceType: "git_url",
          sourceRef: repoDir,
          skillId: "git-runtime-tool",
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
