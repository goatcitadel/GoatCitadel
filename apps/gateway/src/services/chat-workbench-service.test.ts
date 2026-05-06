import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { ChatSessionWorkbenchRecord } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatSessionWorkbenchPatch,
  exportChatSessionWorkbenchPatch,
  parseChangedFilesFromStatus,
  revertChatSessionWorkbenchChanges,
  revertChatSessionWorkbenchFile,
  resolveWorkbenchPathStatus,
  runChatSessionWorkbenchCommand,
  type ChatWorkbenchDependencies,
} from "./chat-workbench-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
    }),
  );
});

describe("chat workbench helpers", () => {
  it("uses the destination path for renamed files in git status output", () => {
    const changedFiles = parseChangedFilesFromStatus(
      "R  workspace/demo/old-name.ts -> workspace/demo/new-name.ts\nM  workspace/demo/index.ts\n",
      "workspace/demo",
    );

    expect(changedFiles).toEqual(["new-name.ts", "index.ts"]);
  });

  it("marks stray existing worktree directories as blocked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-workbench-"));
    tempRoots.push(root);

    const blockedPath = path.join(root, "blocked");
    await fs.mkdir(blockedPath, { recursive: true });
    expect(resolveWorkbenchPathStatus(blockedPath)).toBe("blocked");

    const readyPath = path.join(root, "ready");
    await fs.mkdir(readyPath, { recursive: true });
    await fs.writeFile(path.join(readyPath, ".git"), "gitdir: /tmp/demo/.git/worktrees/ready\n", "utf8");
    expect(resolveWorkbenchPathStatus(readyPath)).toBe("ready");
  });

  it("runs commands in an existing workbench worktree and updates validation state", async () => {
    const { deps } = await createWorkbenchFixture();

    const response = await runChatSessionWorkbenchCommand(deps, "sess-1", {
      command: "npm",
      args: ["--silent", "run", "test:pass"],
      timeoutMs: 5_000,
    });

    expect(response.state.validationStatus).toBe("passed");
    expect(response.state.outputArtifactId).toBe(response.run.commandRunId);
    expect(response.run).toMatchObject({
      command: "npm",
      args: ["--silent", "run", "test:pass"],
      status: "passed",
      exitCode: 0,
      timedOut: false,
      validationStatus: "passed",
      stdoutBytes: 2,
      stderrBytes: 4,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(response.run.stdoutPreview).toBe("ok");
    expect(response.run.stderrPreview).toBe("warn");
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({
        type: "chat_workbench_command_started",
        validationStatus: "pending",
      }),
      expect.any(Object),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({
        type: "chat_workbench_command_completed",
        status: "passed",
        validationStatus: "passed",
      }),
      expect.any(Object),
    );
  });

  it("marks timed out workbench commands as failed validation", async () => {
    const { deps } = await createWorkbenchFixture();

    const response = await runChatSessionWorkbenchCommand(deps, "sess-1", {
      command: "npm",
      args: ["--silent", "run", "test:timeout"],
      timeoutMs: 50,
    });

    expect(response.state.validationStatus).toBe("failed");
    expect(response.run.status).toBe("timed_out");
    expect(response.run.timedOut).toBe(true);
    expect(response.run.validationStatus).toBe("failed");
  });

  it("caps captured stdout and returns a truncated preview", async () => {
    const { deps } = await createWorkbenchFixture();

    const response = await runChatSessionWorkbenchCommand(deps, "sess-1", {
      command: "npm",
      args: ["--silent", "run", "test:large-output"],
      timeoutMs: 5_000,
    });

    expect(response.run.status).toBe("passed");
    expect(response.run.stdoutBytes).toBe(70_000);
    expect(response.run.stdoutTruncated).toBe(true);
    expect(response.run.stdoutPreview).toContain("...[truncated]");
    expect(response.run.stdoutPreview?.length).toBeLessThan(13_000);
  });

  it("rejects non-validation workbench commands before updating validation state", async () => {
    const { deps } = await createWorkbenchFixture();

    await expect(
      runChatSessionWorkbenchCommand(deps, "sess-1", {
        command: "node",
        args: ["-e", "process.exit(0)"],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/Workbench command rejected/);
    expect(deps.storage.chatSessionWorkbench.ensure("sess-1").validationStatus).toBe("idle");
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects patch export when a session has no ready worktree", async () => {
    const { deps } = await createWorkbenchFixture({ worktreeReady: false });

    await expect(exportChatSessionWorkbenchPatch(deps, "sess-1")).rejects.toThrow(
      "This session does not have a ready worktree yet.",
    );
  });

  it("exports, applies, and reverts workbench patches inside the project scope", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "index.ts"), "export const demo = false;\n", "utf8");

    const exported = await exportChatSessionWorkbenchPatch(deps, "sess-1");
    expect(exported.changedFiles).toEqual(["index.ts"]);
    expect(exported.patch).toContain("-export const demo = true;");
    expect(exported.patch).toContain("+export const demo = false;");

    const revertedFile = await revertChatSessionWorkbenchFile(deps, "sess-1", { path: "index.ts" });
    expect(revertedFile.revertedFiles).toEqual(["index.ts"]);
    expect(await readNormalized(path.join(projectRoot, "index.ts"))).toBe("export const demo = true;\n");

    const applied = await applyChatSessionWorkbenchPatch(deps, "sess-1", { patch: exported.patch });
    expect(applied.applied).toBe(true);
    expect(applied.changedFiles).toEqual(["index.ts"]);
    expect(await readNormalized(path.join(projectRoot, "index.ts"))).toBe("export const demo = false;\n");

    const revertedAll = await revertChatSessionWorkbenchChanges(deps, "sess-1");
    expect(revertedAll.revertedFiles).toEqual(["index.ts"]);
    expect(revertedAll.changedFiles).toEqual([]);
    expect(await readNormalized(path.join(projectRoot, "index.ts"))).toBe("export const demo = true;\n");
  });

  it("removes untracked files when reverting all workbench changes", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "scratch.txt"), "temporary\n", "utf8");

    const reverted = await revertChatSessionWorkbenchChanges(deps, "sess-1");

    expect(reverted.revertedFiles).toEqual(["scratch.txt"]);
    await expect(fs.stat(path.join(projectRoot, "scratch.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createWorkbenchFixture(
  options: { worktreeReady?: boolean } = {},
): Promise<{ deps: ChatWorkbenchDependencies }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-workbench-command-"));
  tempRoots.push(rootDir);
  const worktreePath = path.join(rootDir, ".worktrees", "sess-1");
  const projectRoot = path.join(worktreePath, "workspace", "demo");
  if (options.worktreeReady !== false) {
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/demo/.git/worktrees/sess-1\n", "utf8");
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(
        {
          scripts: {
            "test:pass": "node -e \"process.stdout.write('ok'); process.stderr.write('warn');\"",
            "test:timeout": 'node -e "setTimeout(() => {}, 1000);"',
            "test:large-output": "node -e \"process.stdout.write('x'.repeat(70000));\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  let state: ChatSessionWorkbenchRecord = {
    sessionId: "sess-1",
    projectId: "proj-1",
    baseRef: "HEAD",
    worktreePath: options.worktreeReady === false ? undefined : worktreePath,
    worktreeStatus: options.worktreeReady === false ? ("uninitialized" as const) : ("ready" as const),
    activeFilePath: undefined as string | undefined,
    diffArtifactId: undefined as string | undefined,
    outputArtifactId: undefined as string | undefined,
    validationStatus: "idle" as const,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
  };

  const deps: ChatWorkbenchDependencies = {
    config: {
      rootDir,
      assistant: {
        workspaceDir: "workspace",
        worktreesDir: ".worktrees",
      },
      toolPolicy: {
        sandbox: {
          writeJailRoots: [rootDir],
          readOnlyRoots: [],
        },
      },
    } as ChatWorkbenchDependencies["config"],
    storage: {
      chatProjects: {
        get: () => ({
          projectId: "proj-1",
          workspacePath: "demo",
        }),
      },
      chatSessionProjects: {
        get: () => ({
          sessionId: "sess-1",
          projectId: "proj-1",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        }),
      },
      chatSessionWorkbench: {
        ensure: () => state,
        patch: (_sessionId: string, input: Partial<ChatSessionWorkbenchRecord>) => {
          state = {
            ...state,
            ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
            updatedAt: "2026-04-10T00:01:00.000Z",
          };
          return state;
        },
      },
      codeModeRuns: {
        list: () => [],
      },
    } as ChatWorkbenchDependencies["storage"],
    requireChatSession: vi.fn(),
    publishRealtime: vi.fn(),
  };
  return { deps };
}

async function createGitWorkbenchFixture(): Promise<{ deps: ChatWorkbenchDependencies; projectRoot: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-workbench-git-"));
  tempRoots.push(rootDir);
  const worktreePath = path.join(rootDir, ".worktrees", "sess-1");
  const projectRoot = path.join(worktreePath, "workspace", "demo");
  await fs.mkdir(projectRoot, { recursive: true });
  run("git", ["init"], worktreePath);
  run("git", ["config", "user.email", "test@example.com"], worktreePath);
  run("git", ["config", "user.name", "Test User"], worktreePath);
  await fs.writeFile(path.join(projectRoot, "index.ts"), "export const demo = true;\n", "utf8");
  run("git", ["add", "."], worktreePath);
  run("git", ["commit", "-m", "initial"], worktreePath);

  let state: ChatSessionWorkbenchRecord = {
    sessionId: "sess-1",
    projectId: "proj-1",
    baseRef: "HEAD",
    worktreePath,
    worktreeStatus: "ready" as const,
    activeFilePath: undefined as string | undefined,
    diffArtifactId: undefined as string | undefined,
    outputArtifactId: undefined as string | undefined,
    validationStatus: "idle" as const,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
  };

  const deps: ChatWorkbenchDependencies = {
    config: {
      rootDir,
      assistant: {
        workspaceDir: "workspace",
        worktreesDir: ".worktrees",
      },
      toolPolicy: {
        sandbox: {
          writeJailRoots: [rootDir],
          readOnlyRoots: [],
        },
      },
    } as ChatWorkbenchDependencies["config"],
    storage: {
      chatProjects: {
        get: () => ({
          projectId: "proj-1",
          workspacePath: "demo",
        }),
      },
      chatSessionProjects: {
        get: () => ({
          sessionId: "sess-1",
          projectId: "proj-1",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        }),
      },
      chatSessionWorkbench: {
        ensure: () => state,
        patch: (_sessionId: string, input: Partial<ChatSessionWorkbenchRecord>) => {
          state = {
            ...state,
            ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
            updatedAt: "2026-04-10T00:01:00.000Z",
          };
          return state;
        },
      },
      codeModeRuns: {
        list: () => [],
      },
    } as ChatWorkbenchDependencies["storage"],
    requireChatSession: vi.fn(),
    publishRealtime: vi.fn(),
  };
  return { deps, projectRoot };
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function readNormalized(filePath: string): Promise<string> {
  return (await fs.readFile(filePath, "utf8")).replaceAll("\r\n", "\n");
}
