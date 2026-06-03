import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { ChatSessionWorkbenchRecord } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatSessionWorkbenchPatch,
  createChatSessionWorkbenchWorktree,
  detectPackageManagerFromRoot,
  exportChatSessionWorkbenchPatch,
  getChatSessionWorkbench,
  getChatSessionWorkbenchFile,
  getChatSessionWorkbenchFileDiff,
  getChatSessionWorkbenchOutput,
  getChatSessionWorkbenchTree,
  parseChangedFilesFromStatus,
  revertChatSessionWorkbenchChanges,
  revertChatSessionWorkbenchFile,
  resolveWorkbenchPathStatus,
  runChatSessionWorkbenchCommand,
  runChatSessionWorkbenchFileOperation,
  saveChatSessionWorkbenchFile,
  type ChatWorkbenchDependencies,
} from "./chat-workbench-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await removeTestWorkspace(target);
    }),
  );
});

describe("chat workbench helpers", () => {
  it("syncs existing workbench state and hydrates serialized worktree paths", async () => {
    const { deps } = await createWorkbenchFixture();

    const state = await getChatSessionWorkbench(deps, "sess-1");

    expect(deps.requireChatSession).toHaveBeenCalledWith("sess-1");
    expect(state).toMatchObject({
      sessionId: "sess-1",
      projectId: "proj-1",
      worktreeStatus: "ready",
      validationStatus: "idle",
    });
    expect(state.worktreePath).toContain(".worktrees");
  });

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
      timeoutMs: 30_000,
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
  }, 30_000);

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
      timeoutMs: 30_000,
    });

    expect(response.run.status).toBe("passed");
    expect(response.run.stdoutBytes).toBe(70_000);
    expect(response.run.stdoutTruncated).toBe(true);
    expect(response.run.stdoutPreview).toContain("...[truncated]");
    expect(response.run.stdoutPreview?.length).toBeLessThan(13_000);
  }, 30_000);

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
  }, 30_000);

  it("removes untracked files when reverting all workbench changes", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "scratch.txt"), "temporary\n", "utf8");

    const reverted = await revertChatSessionWorkbenchChanges(deps, "sess-1");

    expect(reverted.revertedFiles).toEqual(["scratch.txt"]);
    await expect(fs.stat(path.join(projectRoot, "scratch.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("runs governed file tree operations inside the project workbench scope", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();

    const createdFolder = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "create_folder",
      path: "docs",
    });
    const folderStat = await fs.stat(path.join(projectRoot, "docs"));
    expect(folderStat.isDirectory()).toBe(true);
    expect(createdFolder.output.output).toContain("Created folder docs.");

    const createdFile = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "create_file",
      path: "docs/notes.md",
      content: "# Notes\n",
    });
    expect(createdFile.state.activeFilePath).toBe("docs/notes.md");
    expect(await readNormalized(path.join(projectRoot, "docs", "notes.md"))).toBe("# Notes\n");
    expect(createdFile.tree.items.some((item) => item.path === "docs/notes.md")).toBe(true);

    const renamed = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "rename",
      path: "docs/notes.md",
      targetPath: "docs/renamed.md",
    });
    expect(renamed.state.activeFilePath).toBe("docs/renamed.md");
    await expect(fs.stat(path.join(projectRoot, "docs", "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readNormalized(path.join(projectRoot, "docs", "renamed.md"))).toBe("# Notes\n");

    const duplicated = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "duplicate",
      path: "docs/renamed.md",
      targetPath: "docs/copy.md",
    });
    expect(duplicated.state.activeFilePath).toBe("docs/copy.md");
    expect(await readNormalized(path.join(projectRoot, "docs", "copy.md"))).toBe("# Notes\n");

    const moved = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "move",
      path: "docs/copy.md",
      targetPath: "copy.md",
    });
    expect(moved.state.activeFilePath).toBe("copy.md");
    expect(await readNormalized(path.join(projectRoot, "copy.md"))).toBe("# Notes\n");

    const deleted = await runChatSessionWorkbenchFileOperation(deps, "sess-1", {
      operation: "delete",
      path: "copy.md",
    });
    expect(deleted.state.activeFilePath).toBeFalsy();
    await expect(fs.stat(path.join(projectRoot, "copy.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({ type: "chat_workbench_file_operation_completed", operation: "delete" }),
      expect.objectContaining({ eventAuthority: "retained_stream" }),
    );
  }, 30_000);

  it("rejects file tree operations outside allowed workbench paths", async () => {
    const { deps } = await createGitWorkbenchFixture();

    await expect(
      runChatSessionWorkbenchFileOperation(deps, "sess-1", {
        operation: "create_file",
        path: "../escape.ts",
      }),
    ).rejects.toThrow(/Invalid relative path/);
    await expect(
      runChatSessionWorkbenchFileOperation(deps, "sess-1", {
        operation: "delete",
        path: ".git/config",
      }),
    ).rejects.toThrow(/Git metadata/);
    await expect(
      runChatSessionWorkbenchFileOperation(deps, "sess-1", {
        operation: "delete",
        path: ".GIT/config",
      }),
    ).rejects.toThrow(/Git metadata/);
    await expect(
      runChatSessionWorkbenchFileOperation(deps, "sess-1", {
        operation: "create_file",
        path: "NODE_MODULES/pkg/index.js",
      }),
    ).rejects.toThrow(/node_modules/);
  }, 30_000);

  it("rejects symlink destinations and parents before workbench writes", async () => {
    const { deps, projectRoot, rootDir } = await createGitWorkbenchFixture();
    const createOutsideTarget = path.join(os.tmpdir(), `goatcitadel-workbench-create-${Date.now()}-${process.pid}.txt`);
    const createLinkPath = path.join(projectRoot, "dangling-create.md");
    const canCreateFileSymlinks = await createDanglingFileSymlink(createLinkPath, createOutsideTarget);
    if (canCreateFileSymlinks) {
      await expect(
        runChatSessionWorkbenchFileOperation(deps, "sess-1", {
          operation: "create_file",
          path: "dangling-create.md",
          content: "created outside\n",
        }),
      ).rejects.toThrow(/target already exists/);
      await expect(fs.stat(createOutsideTarget)).rejects.toMatchObject({ code: "ENOENT" });

      const saveOutsideTarget = path.join(os.tmpdir(), `goatcitadel-workbench-save-${Date.now()}-${process.pid}.txt`);
      const saveLinkPath = path.join(projectRoot, "dangling-save.md");
      if (await createDanglingFileSymlink(saveLinkPath, saveOutsideTarget)) {
        await expect(
          saveChatSessionWorkbenchFile(deps, "sess-1", {
            path: "dangling-save.md",
            content: "saved outside\n",
          }),
        ).rejects.toThrow(/dangling symbolic link/);
        await expect(fs.stat(saveOutsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await fs.rm(saveOutsideTarget, { force: true });

      await fs.writeFile(path.join(projectRoot, "source.md"), "source\n", "utf8");
      const duplicateOutsideTarget = path.join(
        os.tmpdir(),
        `goatcitadel-workbench-duplicate-${Date.now()}-${process.pid}.txt`,
      );
      const duplicateLinkPath = path.join(projectRoot, "dangling-duplicate.md");
      if (await createDanglingFileSymlink(duplicateLinkPath, duplicateOutsideTarget)) {
        await expect(
          runChatSessionWorkbenchFileOperation(deps, "sess-1", {
            operation: "duplicate",
            path: "source.md",
            targetPath: "dangling-duplicate.md",
          }),
        ).rejects.toThrow(/target already exists/);
        await expect(fs.stat(duplicateOutsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await fs.rm(duplicateOutsideTarget, { force: true });
    } else {
      expect(process.platform).toBe("win32");
      console.warn("Skipping file-symlink workbench escape coverage; Windows file symlink privileges are unavailable.");
    }

    const outsideProjectDir = path.join(rootDir, "outside-project");
    await fs.mkdir(outsideProjectDir, { recursive: true });
    const linkedParentPath = path.join(projectRoot, "linked-parent");
    if (!(await createDirectorySymlink(linkedParentPath, outsideProjectDir))) {
      throw new Error("Directory symlink/junction coverage unavailable; cannot verify parent escape guard.");
    }
    await expect(
      runChatSessionWorkbenchFileOperation(deps, "sess-1", {
        operation: "create_file",
        path: "linked-parent/escaped.md",
        content: "escaped project scope\n",
      }),
    ).rejects.toThrow(/outside the project root/);
    await expect(fs.stat(path.join(outsideProjectDir, "escaped.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      saveChatSessionWorkbenchFile(deps, "sess-1", {
        path: "linked-parent/escaped-save.md",
        content: "escaped save scope\n",
      }),
    ).rejects.toThrow(/outside the project root/);
    await expect(fs.stat(path.join(outsideProjectDir, "escaped-save.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(createOutsideTarget, { force: true });
  }, 30_000);

  it("creates a workbench worktree from a git project and publishes the lifecycle event", async () => {
    const { deps, rootDir } = await createGitWorkbenchFixture({ worktreeReady: false });

    const state = await createChatSessionWorkbenchWorktree(deps, "sess-1", { baseRef: "HEAD" });

    expect(state).toMatchObject({
      sessionId: "sess-1",
      projectId: "proj-1",
      baseRef: "HEAD",
      worktreeStatus: "ready",
    });
    expect(state.worktreePath).toBe("./.worktrees/sess-1");
    const hydratedWorktreePath = path.resolve(rootDir, state.worktreePath.replace(/^\.\//, ""));
    await expect(fs.stat(path.join(hydratedWorktreePath, ".git"))).resolves.toBeDefined();
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({
        type: "chat_workbench_worktree_created",
        sessionId: "sess-1",
        projectId: "proj-1",
        baseRef: "HEAD",
      }),
    );
  }, 30_000);

  it("skips post-write validation when a save leaves the worktree unchanged", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    const existingContent = await fs.readFile(path.join(projectRoot, "index.ts"), "utf8");

    const file = await saveChatSessionWorkbenchFile(deps, "sess-1", {
      path: "index.ts",
      content: existingContent,
    });

    expect(file.changed).toBe(false);
    expect(file.state.validationStatus).toBe("idle");
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({
        type: "chat_workbench_post_write_validation_completed",
        validationStatus: "idle",
        validation: expect.objectContaining({
          status: "skipped",
          reason: "No changed files were detected after the write.",
          changedFiles: [],
        }),
      }),
      expect.objectContaining({
        eventAuthority: "retained_stream",
      }),
    );
  }, 30_000);

  it("returns a scoped tree and marks changed nested files without surfacing node_modules", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "node_modules", "ignored"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "feature.ts"), "export const changed = true;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "node_modules", "ignored", "index.js"), "ignored\n", "utf8");

    const tree = await getChatSessionWorkbenchTree(deps, "sess-1");

    expect(tree.rootPath).toBe("demo");
    expect(tree.changedFiles).toContain("src/");
    expect(tree.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src", kind: "directory", changed: true }),
        expect.objectContaining({ path: "src/feature.ts", kind: "file", depth: 1 }),
      ]),
    );
    expect(tree.items.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
  }, 30_000);

  it("guards workbench file saves and reads at file boundary errors", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });

    await expect(
      saveChatSessionWorkbenchFile(deps, "sess-1", {
        path: "large.txt",
        content: "x".repeat(256 * 1024 + 1),
      }),
    ).rejects.toThrow(/too large for the workbench editor/i);
    await expect(
      saveChatSessionWorkbenchFile(deps, "sess-1", {
        path: "src",
        content: "not a file",
      }),
    ).rejects.toThrow(/Path is a directory: src/);
    await expect(
      saveChatSessionWorkbenchFile(deps, "sess-1", {
        path: "missing/child.ts",
        content: "export const child = true;\n",
      }),
    ).rejects.toThrow(/Parent directory does not exist/);

    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "missing.ts")).rejects.toThrow(/Workbench file/);
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "src")).rejects.toThrow(/Path is a directory: src/);
    await fs.writeFile(path.join(projectRoot, "too-large.txt"), "x".repeat(256 * 1024 + 1), "utf8");
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "too-large.txt")).rejects.toThrow(
      /too large for the workbench viewer/i,
    );
  }, 30_000);

  it("saves files, runs post-write validation, and rejects invalid changed JSON before git validation", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "config.json"), "{}\n", "utf8");
    run("git", ["add", "."], path.dirname(path.dirname(projectRoot)));
    run("git", ["commit", "-m", "add json"], path.dirname(path.dirname(projectRoot)));

    const file = await saveChatSessionWorkbenchFile(deps, "sess-1", {
      path: "config.json",
      content: "{ invalid json",
    });
    expect(file).toEqual(
      expect.objectContaining({
        path: "config.json",
        changed: true,
        diagnostics: [
          expect.objectContaining({
            source: "json_parse",
            severity: "error",
            filePath: "config.json",
            code: "workbench.validation.failed",
          }),
        ],
      }),
    );

    const publishedValidation = vi
      .mocked(deps.publishRealtime)
      .mock.calls.find(([, , payload]) => payload.type === "chat_workbench_post_write_validation_completed")?.[2];
    expect(publishedValidation).toEqual(
      expect.objectContaining({
        validationStatus: "failed",
        validation: expect.objectContaining({
          status: "failed",
          commandLabel: "JSON parse",
          reason: "Changed JSON failed to parse.",
          changedFiles: ["config.json"],
        }),
        diagnostics: [
          expect.objectContaining({
            source: "json_parse",
            filePath: "config.json",
          }),
        ],
      }),
    );
    expect(deps.storage.chatSessionWorkbench.ensure("sess-1").validationStatus).toBe("failed");
  }, 30_000);

  it("reads workbench files with language metadata and rejects binary viewer payloads", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Notes\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "app.js"), "export const app = true;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "style.css"), "body { color: black; }\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "index.html"), "<main>Hello</main>\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "notes"), "plain text\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "binary.dat"), Buffer.from([0, 1, 2, 3, 4, 5]));

    const file = await getChatSessionWorkbenchFile(deps, "sess-1", "README.md");

    expect(file).toEqual(
      expect.objectContaining({
        path: "README.md",
        contentType: "text/markdown",
        language: "md",
        content: "# Notes\n",
      }),
    );
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "app.js")).resolves.toMatchObject({
      contentType: "text/javascript",
      language: "js",
    });
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "style.css")).resolves.toMatchObject({
      contentType: "text/css",
      language: "css",
    });
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "index.html")).resolves.toMatchObject({
      contentType: "text/html",
      language: "html",
    });
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "notes")).resolves.toMatchObject({
      contentType: "text/plain",
      language: "text",
    });
    await expect(getChatSessionWorkbenchFile(deps, "sess-1", "binary.dat")).rejects.toThrow(/binary/i);
  }, 30_000);

  it("returns original and modified content for changed and untracked file diffs", async () => {
    const { deps, projectRoot } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(projectRoot, "index.ts"), "export const demo = false;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "new-file.ts"), "export const added = true;\n", "utf8");

    await expect(getChatSessionWorkbenchFileDiff(deps, "sess-1", "index.ts")).resolves.toMatchObject({
      path: "index.ts",
      changed: true,
      originalContent: "export const demo = true;\n",
      modifiedContent: "export const demo = false;\n",
    });
    await expect(getChatSessionWorkbenchFileDiff(deps, "sess-1", "new-file.ts")).resolves.toMatchObject({
      path: "new-file.ts",
      changed: true,
      originalContent: "",
      modifiedContent: "export const added = true;\n",
    });
  }, 30_000);

  it("returns unchanged file diffs from the current worktree content", async () => {
    const { deps } = await createGitWorkbenchFixture();

    const diff = await getChatSessionWorkbenchFileDiff(deps, "sess-1", "index.ts");

    expect(diff).toMatchObject({
      path: "index.ts",
      changed: false,
    });
    expect(diff.originalContent.replaceAll("\r\n", "\n")).toBe("export const demo = true;\n");
    expect(diff.modifiedContent.replaceAll("\r\n", "\n")).toBe("export const demo = true;\n");
  }, 30_000);

  it("throws failed patch output when a scoped patch cannot apply", async () => {
    const { deps } = await createGitWorkbenchFixture();
    const patch = [
      "diff --git a/workspace/demo/index.ts b/workspace/demo/index.ts",
      "--- a/workspace/demo/index.ts",
      "+++ b/workspace/demo/index.ts",
      "@@ -99,1 +99,1 @@",
      "-missing line",
      "+replacement line",
      "",
    ].join("\n");

    await expect(applyChatSessionWorkbenchPatch(deps, "sess-1", { patch })).rejects.toThrow(/patch/i);
    expect(deps.storage.chatSessionWorkbench.ensure("sess-1").validationStatus).toBe("failed");
  }, 30_000);

  it("summarizes helper run output and maps latest helper status onto validation state", async () => {
    const { deps } = await createWorkbenchFixture();
    deps.storage.codeModeRuns.list = vi.fn(() => [
      {
        runId: "run-latest",
        sessionId: "sess-1",
        status: "failed",
        language: "typescript",
        requestedOutputIntent: "validate",
        stdoutPreview: "stdout tail",
        stderrPreview: "stderr tail",
        createdAt: "2026-04-10T00:02:00.000Z",
      },
      {
        runId: "run-other-session",
        sessionId: "other",
        status: "completed",
        language: "typescript",
        requestedOutputIntent: "validate",
        stdoutPreview: "hidden",
        stderrPreview: "",
        createdAt: "2026-04-10T00:01:00.000Z",
      },
    ]) as never;

    const output = await getChatSessionWorkbenchOutput(deps, "sess-1");

    expect(output.state.validationStatus).toBe("failed");
    expect(output.state.outputArtifactId).toBe("code-mode-run:run-latest");
    expect(output.helperRuns).toHaveLength(1);
    expect(output.output).toContain("typescript helper");
    expect(output.output).toContain("stdout tail");
    expect(output.output).toContain("stderr tail");
  });

  it("uses hydrated session-scoped Code Mode runs for helper validation state", async () => {
    const { deps } = await createWorkbenchFixture();
    deps.storage.codeModeRuns.list = vi.fn(() => {
      throw new Error("global Code Mode listing should not be used");
    }) as never;
    deps.listCodeModeRuns = vi.fn(() => [
      {
        runId: "run-expired",
        sessionId: "sess-1",
        status: "expired",
        language: "typescript",
        requestedOutputIntent: "validate",
        stdoutPreview: "",
        stderrPreview: "approval expired",
        createdAt: "2026-04-10T00:03:00.000Z",
      },
    ]) as never;

    const output = await getChatSessionWorkbenchOutput(deps, "sess-1");

    expect(deps.listCodeModeRuns).toHaveBeenCalledWith({ sessionId: "sess-1", limit: 8 });
    expect(output.state.validationStatus).toBe("failed");
    expect(output.state.outputArtifactId).toBe("code-mode-run:run-expired");
    expect(output.output).toContain("typescript helper · expired");
    expect(output.output).toContain("approval expired");
  });

  it("reports idle and stored validation output when no helper runs exist", async () => {
    const { deps } = await createWorkbenchFixture();

    await expect(getChatSessionWorkbenchOutput(deps, "sess-1")).resolves.toEqual(
      expect.objectContaining({
        helperRuns: [],
        output: "No validation output yet.",
        state: expect.objectContaining({ validationStatus: "idle" }),
      }),
    );

    deps.storage.chatSessionWorkbench.patch("sess-1", { validationStatus: "passed" });
    await expect(getChatSessionWorkbenchOutput(deps, "sess-1")).resolves.toEqual(
      expect.objectContaining({
        helperRuns: [],
        output: "Latest validation status: passed.",
        state: expect.objectContaining({ validationStatus: "passed" }),
      }),
    );
  });
});

describe("detectPackageManagerFromRoot", () => {
  it("returns pnpm when pnpm-lock.yaml is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-pnpm-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    expect(detectPackageManagerFromRoot(root)).toBe("pnpm");
  });

  it("returns npm when only package-lock.json is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-npm-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    expect(detectPackageManagerFromRoot(root)).toBe("npm");
  });

  it("returns yarn when only yarn.lock is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-yarn-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "yarn.lock"), "# yarn lockfile\n", "utf8");
    expect(detectPackageManagerFromRoot(root)).toBe("yarn");
  });

  it("returns bun when only bun.lockb is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-bun-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "bun.lockb"), "", "utf8");
    expect(detectPackageManagerFromRoot(root)).toBe("bun");
  });

  it("returns undefined when no recognized lockfile is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-none-"));
    tempRoots.push(root);
    expect(detectPackageManagerFromRoot(root)).toBeUndefined();
  });

  it("prefers pnpm-lock.yaml when multiple lockfiles coexist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-pm-priority-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await fs.writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    expect(detectPackageManagerFromRoot(root)).toBe("pnpm");
  });
});

describe("chat workbench package manager hydration", () => {
  it("hydrates packageManager from the project workspace lockfile", async () => {
    const { deps, rootDir } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(rootDir, "workspace", "demo", "package-lock.json"), "{}", "utf8");

    const state = await getChatSessionWorkbench(deps, "sess-1");

    expect(state.packageManager).toBe("npm");
  });

  it("falls back to repo-root lockfile when the project subpath has none", async () => {
    const { deps, rootDir } = await createGitWorkbenchFixture();
    await fs.writeFile(path.join(rootDir, "yarn.lock"), "# yarn lockfile\n", "utf8");

    const state = await getChatSessionWorkbench(deps, "sess-1");

    expect(state.packageManager).toBe("yarn");
  });

  it("leaves packageManager undefined when no lockfile exists at either root", async () => {
    const { deps } = await createGitWorkbenchFixture();

    const state = await getChatSessionWorkbench(deps, "sess-1");

    expect(state.packageManager).toBeUndefined();
  });

  it("keeps the cached packageManager when the lockfile changes mid-session", async () => {
    const { deps, rootDir } = await createGitWorkbenchFixture();
    const lockfilePath = path.join(rootDir, "workspace", "demo", "package-lock.json");
    await fs.writeFile(lockfilePath, "{}", "utf8");

    const initial = await getChatSessionWorkbench(deps, "sess-1");
    expect(initial.packageManager).toBe("npm");

    await fs.rm(lockfilePath, { force: true });
    await fs.writeFile(path.join(rootDir, "workspace", "demo", "yarn.lock"), "# yarn lockfile\n", "utf8");

    const afterChange = await getChatSessionWorkbench(deps, "sess-1");
    expect(afterChange.packageManager).toBe("npm");
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

async function createGitWorkbenchFixture(
  options: { worktreeReady?: boolean } = {},
): Promise<{ deps: ChatWorkbenchDependencies; projectRoot: string; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-workbench-git-"));
  tempRoots.push(rootDir);
  const sourceProjectRoot = path.join(rootDir, "workspace", "demo");
  await fs.mkdir(sourceProjectRoot, { recursive: true });
  run("git", ["init"], rootDir);
  run("git", ["config", "user.email", "test@example.com"], rootDir);
  run("git", ["config", "user.name", "Test User"], rootDir);
  await fs.writeFile(path.join(sourceProjectRoot, "index.ts"), "export const demo = true;\n", "utf8");
  run("git", ["add", "."], rootDir);
  run("git", ["commit", "-m", "initial"], rootDir);

  const worktreePath = path.join(rootDir, ".worktrees", "sess-1");
  if (options.worktreeReady !== false) {
    run("git", ["worktree", "add", worktreePath, "HEAD"], rootDir);
  }
  const projectRoot = path.join(worktreePath, "workspace", "demo");

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
  return { deps, projectRoot, rootDir };
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

async function createDanglingFileSymlink(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.symlink(targetPath, linkPath, "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}

async function createDirectorySymlink(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}

async function removeTestWorkspace(target: string): Promise<void> {
  const transientCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!transientCodes.has(String(code)) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
