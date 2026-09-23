import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function createRepository(): Promise<{ repoRoot: string; worktreesRoot: string; marker: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-worktree-env-"));
  roots.push(root);
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, stdio: "ignore", windowsHide: true });
  git("init");
  git("config", "user.name", "Worktree Env Fixture");
  git("config", "user.email", "worktree-env@example.invalid");
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  await fs.writeFile(path.join(hooksDir, "post-checkout"), HOOK, { mode: 0o755 });
  // Repository-local hooksPath outranks any global core.hooksPath on the test host.
  git("config", "core.hooksPath", hooksDir.replaceAll("\\", "/"));
  git("commit", "--allow-empty", "-m", "Initialize worktree env fixture");
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
});
