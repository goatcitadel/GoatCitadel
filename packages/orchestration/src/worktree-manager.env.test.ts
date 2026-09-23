import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GIT_REPOSITORY_ENV_KEYS } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "./worktree-manager.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

// A repository-controlled post-checkout hook records which gateway variables reach it.
const HOOK = [
  "#!/bin/sh",
  'presence() { if [ -n "$1" ]; then printf present; else printf absent; fi; }',
  'printf "%s|%s|%s|%s" "$(presence "$GOATCITADEL_WT_FIXTURE_TOKEN")" "$(presence "$SSH_AUTH_SOCK")" \\',
  '  "$(presence "$GOATCITADEL_WT_FIXTURE_API_KEY")" "$(presence "$GOATCITADEL_WT_FIXTURE_ORDINARY")" \\',
  '  > "$GOATCITADEL_WT_FIXTURE_MARKER"',
  "",
].join("\n");

const REPOSITORY_ENV_KEYS = new Set<string>(GIT_REPOSITORY_ENV_KEYS);

// Fixture git must never follow a repository location inherited from a hook that launched the test run.
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !REPOSITORY_ENV_KEYS.has(key.toUpperCase())),
  );
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

async function initRepository(repoRoot: string, message: string): Promise<void> {
  await fs.mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init");
  git(repoRoot, "config", "user.name", "Worktree Env Fixture");
  git(repoRoot, "config", "user.email", "worktree-env@example.invalid");
  git(repoRoot, "commit", "--allow-empty", "-m", message);
}

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-worktree-env-"));
  roots.push(root);
  return root;
}

async function createRepository(): Promise<{ repoRoot: string; worktreesRoot: string; marker: string }> {
  const root = await createRoot();
  const repoRoot = path.join(root, "repo");
  await initRepository(repoRoot, "Initialize worktree env fixture");
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  await fs.writeFile(path.join(hooksDir, "post-checkout"), HOOK, { mode: 0o755 });
  // Repository-local hooksPath outranks any global core.hooksPath on the test host.
  git(repoRoot, "config", "core.hooksPath", hooksDir.replaceAll("\\", "/"));
  return { repoRoot, worktreesRoot: path.join(root, "worktrees"), marker: path.join(root, "hook-env.txt") };
}

describe("WorktreeManager child environment", () => {
  it("keeps credential-shaped gateway variables away from checkout hooks", async () => {
    const fixture = await createRepository();
    vi.stubEnv("GOATCITADEL_WT_FIXTURE_TOKEN", "gateway-secret-value");
    vi.stubEnv("SSH_AUTH_SOCK", path.join(os.tmpdir(), "agent.sock"));
    vi.stubEnv("GOATCITADEL_WT_FIXTURE_API_KEY", "operator-opted-in");
    vi.stubEnv("GOATCITADEL_WT_FIXTURE_ORDINARY", "ordinary-value");
    vi.stubEnv("GOATCITADEL_WT_FIXTURE_MARKER", fixture.marker.replaceAll("\\", "/"));

    await new WorktreeManager({ repoRoot: fixture.repoRoot, worktreesRoot: fixture.worktreesRoot }).create("scrubbed");
    expect(await fs.readFile(fixture.marker, "utf8")).toBe("absent|present|absent|present");

    await new WorktreeManager({
      repoRoot: fixture.repoRoot,
      worktreesRoot: fixture.worktreesRoot,
      spawnEnvPassthrough: ["GOATCITADEL_WT_FIXTURE_API_KEY"],
    }).create("operator-opt-out");
    expect(await fs.readFile(fixture.marker, "utf8")).toBe("absent|present|present|present");
  }, 30_000);

  it("creates the worktree from repoRoot even when a repository location is inherited", async () => {
    const root = await createRoot();
    const repoRoot = path.join(root, "repo");
    const decoyRoot = path.join(root, "decoy");
    await initRepository(repoRoot, "Configured repository");
    await initRepository(decoyRoot, "Decoy repository");
    vi.stubEnv("GIT_DIR", path.join(decoyRoot, ".git"));
    vi.stubEnv("GIT_WORK_TREE", decoyRoot);

    const worktreePath = await new WorktreeManager({ repoRoot, worktreesRoot: path.join(root, "worktrees") }).create(
      "pinned",
    );

    expect(git(worktreePath, "log", "-1", "--format=%s")).toBe("Configured repository");
    expect(git(decoyRoot, "worktree", "list", "--porcelain")).not.toContain("pinned");
  }, 30_000);
});
