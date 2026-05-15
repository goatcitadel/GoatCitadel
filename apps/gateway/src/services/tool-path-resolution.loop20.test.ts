import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { resolveProjectRootForToolContext, resolveToolRequestPaths } from "./tool-path-resolution.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("tool path resolution loop20 tails", () => {
  it("returns the original request when no path spec or path mutation applies", async () => {
    const workspaceRoot = await makeTempWorkspace();
    const unsupported: ToolInvokeRequest = {
      toolName: "session.status",
      args: { path: "src/index.ts" },
      agentId: "agent",
      sessionId: "session",
    };
    const blankRead: ToolInvokeRequest = {
      toolName: "fs.read",
      args: { path: "   " },
      agentId: "agent",
      sessionId: "session",
    };

    expect(resolveToolRequestPaths(unsupported, { workspaceRoot })).toBe(unsupported);
    expect(resolveToolRequestPaths(blankRead, { workspaceRoot })).toBe(blankRead);
  });

  it("uses the workspace root as the default cwd or listing path when no project is selected", async () => {
    const workspaceRoot = await makeTempWorkspace();

    const shell = resolveToolRequestPaths(
      {
        toolName: "shell.exec_background",
        args: { command: "pnpm test" },
        agentId: "agent",
        sessionId: "session",
      },
      { workspaceRoot },
    );
    const list = resolveToolRequestPaths(
      {
        toolName: "fs.list",
        args: {},
        agentId: "agent",
        sessionId: "session",
      },
      { workspaceRoot },
    );

    expect(shell.args.cwd).toBe(workspaceRoot);
    expect(list.args.path).toBe(workspaceRoot);
  });

  it("resolves non-sentinel project workspace paths and project-base shorthand", async () => {
    const { repoRoot, workspaceRoot, projectRoot } = await makeProjectWorkspace();

    expect(
      resolveProjectRootForToolContext({
        repoRoot,
        workspaceRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      }),
    ).toBe(projectRoot);

    const resolved = resolveToolRequestPaths(
      {
        toolName: "fs.stat",
        args: { path: "prompt-pack-workspace" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );

    expect(resolved.args.path).toBe(projectRoot);
  });

  it("keeps workspace-prefixed paths at the workspace root when the workspace candidate exists", async () => {
    const { workspaceRoot, projectRoot } = await makeProjectWorkspace();
    await fs.mkdir(path.join(workspaceRoot, "fixtures", "prompt-pack-workspace", "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "fixtures", "prompt-pack-workspace", "docs", "root.md"), "root\n");

    const resolved = resolveToolRequestPaths(
      {
        toolName: "file.find",
        args: { path: "fixtures/prompt-pack-workspace/docs/root.md" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );

    expect(resolved.args.path).toBe(path.join(workspaceRoot, "fixtures", "prompt-pack-workspace", "docs", "root.md"));
  });

  it("falls through workspace-prefixed candidates when the preferred root does not exist", async () => {
    const { workspaceRoot, projectRoot } = await makeProjectWorkspace();
    await fs.mkdir(path.join(projectRoot, "fixtures", "prompt-pack-workspace", "docs"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "fixtures", "prompt-pack-workspace", "docs", "project-copy.md"),
      "project\n",
    );

    const projectFallback = resolveToolRequestPaths(
      {
        toolName: "file.read_range",
        args: { path: "fixtures/prompt-pack-workspace/docs/project-copy.md" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );
    const missingFallback = resolveToolRequestPaths(
      {
        toolName: "file.read_range",
        args: { path: "fixtures/prompt-pack-workspace/docs/missing.md" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );

    expect(projectFallback.args.path).toBe(
      path.join(projectRoot, "fixtures", "prompt-pack-workspace", "docs", "project-copy.md"),
    );
    expect(missingFallback.args.path).toBe(
      path.join(workspaceRoot, "fixtures", "prompt-pack-workspace", "docs", "missing.md"),
    );
  });

  it("falls back between project and workspace candidates for non-prefixed relative paths", async () => {
    const { workspaceRoot, projectRoot } = await makeProjectWorkspace();
    await fs.mkdir(path.join(workspaceRoot, "shared"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "shared", "root.txt"), "root\n");

    const workspaceFallback = resolveToolRequestPaths(
      {
        toolName: "fs.read",
        args: { path: "shared/root.txt" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );
    const missingFallback = resolveToolRequestPaths(
      {
        toolName: "fs.read",
        args: { path: "missing/new.txt" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      },
    );

    expect(workspaceFallback.args.path).toBe(path.join(workspaceRoot, "shared", "root.txt"));
    expect(missingFallback.args.path).toBe(path.join(projectRoot, "missing", "new.txt"));
  });

  it("bounds absolute roots and resolves prompt-pack sentinel roots", async () => {
    const { repoRoot, workspaceRoot } = await makeProjectWorkspace();
    expect(resolveProjectRootForToolContext({ workspaceRoot, repoRoot })).toBeUndefined();

    const rootPath = path.parse(workspaceRoot).root;
    expect(() =>
      resolveToolRequestPaths(
        {
          toolName: "fs.write",
          args: { path: rootPath, content: "nope" },
          agentId: "agent",
          sessionId: "session",
        },
        { workspaceRoot },
      ),
    ).toThrow(ValidationError);
  });

  it("allows absolute paths inside the active workspace boundary", async () => {
    const workspaceRoot = await makeTempWorkspace();
    const absoluteFile = path.join(workspaceRoot, "inside.txt");
    await fs.writeFile(absoluteFile, "inside\n");

    const resolved = resolveToolRequestPaths(
      {
        toolName: "fs.stat",
        args: { path: absoluteFile },
        agentId: "agent",
        sessionId: "session",
      },
      { workspaceRoot },
    );

    expect(resolved.args.path).toBe(absoluteFile);
  });
});

async function makeTempWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-tool-path-loop20-"));
  tempRoots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function makeProjectWorkspace(): Promise<{
  repoRoot: string;
  workspaceRoot: string;
  projectRoot: string;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-tool-project-loop20-"));
  tempRoots.push(repoRoot);
  const workspaceRoot = path.join(repoRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "fixtures", "prompt-pack-workspace");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  return { repoRoot, workspaceRoot, projectRoot };
}
