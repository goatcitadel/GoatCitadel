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

describe("resolveToolRequestPaths", () => {
  it("maps the prompt-pack repo sentinel back to the repository root", async () => {
    const { workspaceRoot, repoRoot } = await createWorkspaceFixture();

    const projectRoot = resolveProjectRootForToolContext({
      workspaceRoot,
      repoRoot,
      projectWorkspacePath: "__prompt_pack_repo__",
    });

    expect(projectRoot).toBe(repoRoot);
  });

  it("keeps workspace-relative prompt-pack paths anchored to the workspace root", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: "fixtures/prompt-pack-workspace/src/utils.ts" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(path.join(projectRoot, "src", "utils.ts"));
  });

  it("falls back to the assigned project root for project-local source paths", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: "src/utils.ts" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(path.join(projectRoot, "src", "utils.ts"));
  });

  it("collapses a redundant project-name prefix back to the assigned project root", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "code.search",
      args: { path: "prompt-pack-workspace/src/utils.ts", query: "slugify" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(path.join(projectRoot, "src", "utils.ts"));
  });

  it("prefers the assigned project root for top-level files when both roots contain a match", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    await fs.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"workspace-root"}\n', "utf8");
    await fs.writeFile(path.join(projectRoot, "package.json"), '{"name":"prompt-pack"}\n', "utf8");
    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: "package.json" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(path.join(projectRoot, "package.json"));
  });

  it("binds dot search roots to the assigned project root", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "code.search_files",
      args: { path: ".", query: "utils" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(projectRoot);
  });

  it("rejects filesystem root placeholders for read operations", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const fsRoot = path.parse(workspaceRoot).root;
    const request: ToolInvokeRequest = {
      toolName: "code.search_files",
      args: { path: fsRoot, query: "package.json" },
      agentId: "agent",
      sessionId: "session",
    };

    let caught: unknown;
    try {
      resolveToolRequestPaths(request, {
        workspaceRoot,
        projectRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain(
      'Use a relative path such as "." to target the project root.',
    );
  });

  it("preserves filesystem root convenience for cwd resolution", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { cwd: path.parse(workspaceRoot).root, command: "pwd" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.cwd).toBe(projectRoot);
  });

  it("routes project-relative write targets into the assigned project root", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "fs.write",
      args: { path: "src/new-endpoint.ts", content: "export {};" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(path.join(projectRoot, "src", "new-endpoint.ts"));
  });

  it("injects the assigned project root as default cwd for shell and restricted runner tools", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const shellRequest: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: "node --version" },
      agentId: "agent",
      sessionId: "session",
    };
    const testRequest: ToolInvokeRequest = {
      toolName: "tests.run",
      args: { manager: "npm" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolvedShell = resolveToolRequestPaths(shellRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });
    const resolvedTests = resolveToolRequestPaths(testRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolvedShell.args.cwd).toBe(projectRoot);
    expect(resolvedTests.args.cwd).toBe(projectRoot);
  });

  it("injects the assigned project root as default path for fs.list and fs.stat", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const listRequest: ToolInvokeRequest = {
      toolName: "fs.list",
      args: {},
      agentId: "agent",
      sessionId: "session",
    };
    const statRequest: ToolInvokeRequest = {
      toolName: "fs.stat",
      args: {},
      agentId: "agent",
      sessionId: "session",
    };

    const resolvedList = resolveToolRequestPaths(listRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });
    const resolvedStat = resolveToolRequestPaths(statRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolvedList.args.path).toBe(projectRoot);
    expect(resolvedStat.args.path).toBe(projectRoot);
  });

  it("normalizes docs.ingest file sources before policy evaluation while leaving url and text sources untouched", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "docs", "source.md"), "# Source\n", "utf8");

    const fileRequest: ToolInvokeRequest = {
      toolName: "docs.ingest",
      args: { sourceType: "file", source: "docs/source.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session",
    };
    const urlRequest: ToolInvokeRequest = {
      toolName: "docs.ingest",
      args: { sourceType: "url", source: "https://example.com/docs.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session",
    };
    const textRequest: ToolInvokeRequest = {
      toolName: "docs.ingest",
      args: { sourceType: "text", source: "inline docs", namespace: "research" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolvedFile = resolveToolRequestPaths(fileRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });
    const resolvedUrl = resolveToolRequestPaths(urlRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });
    const resolvedText = resolveToolRequestPaths(textRequest, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolvedFile.args.source).toBe(path.join(projectRoot, "docs", "source.md"));
    expect(resolvedUrl).toBe(urlRequest);
    expect(resolvedText).toBe(textRequest);
  });

  it("preserves absolute outside-workspace read paths for policy evaluation", async () => {
    const { projectRoot, workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const outsideFile = path.join(outsideRoot, "escape.txt");
    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: outsideFile },
      agentId: "agent",
      sessionId: "session",
    };

    await fs.writeFile(outsideFile, "nope\n", "utf8");

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.path).toBe(await fs.realpath(outsideFile));
  });

  it("resolves symlinked relative read paths that escape the workspace boundary for policy evaluation", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const outsideDir = path.join(outsideRoot, "linked-outside");
    const linkDir = path.join(workspaceRoot, "linked-outside");
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(outsideFile, "shh\n", "utf8");
    await createDirectoryLink(outsideDir, linkDir);

    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: "linked-outside/secret.txt" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
    });

    expect(resolved.args.path).toBe(await fs.realpath(outsideFile));
  });

  it("rejects symlinked relative write targets that escape the workspace boundary", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const outsideDir = path.join(outsideRoot, "linked-write");
    const linkDir = path.join(workspaceRoot, "linked-write");
    await fs.mkdir(outsideDir, { recursive: true });
    await createDirectoryLink(outsideDir, linkDir);

    const request: ToolInvokeRequest = {
      toolName: "fs.write",
      args: { path: "linked-write/new-file.ts", content: "export {};\n" },
      agentId: "agent",
      sessionId: "session",
    };

    expect(() =>
      resolveToolRequestPaths(request, {
        workspaceRoot,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects symlinked relative cwd targets that escape the workspace boundary", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const outsideDir = path.join(outsideRoot, "linked-cwd");
    const linkDir = path.join(workspaceRoot, "linked-cwd");
    await fs.mkdir(outsideDir, { recursive: true });
    await createDirectoryLink(outsideDir, linkDir);

    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { cwd: "linked-cwd", command: "pwd" },
      agentId: "agent",
      sessionId: "session",
    };

    expect(() =>
      resolveToolRequestPaths(request, {
        workspaceRoot,
      }),
    ).toThrow(ValidationError);
  });
});

async function createWorkspaceFixture(): Promise<{
  repoRoot: string;
  workspaceRoot: string;
  projectRoot: string;
  outsideRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-tool-paths-"));
  tempRoots.push(root);
  const repoRoot = root;
  const workspaceRoot = path.join(repoRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "fixtures", "prompt-pack-workspace");
  const outsideRoot = path.join(repoRoot, "outside");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "utils.ts"), "export const slugify = () => '';\n", "utf8");
  return { repoRoot, workspaceRoot, projectRoot, outsideRoot };
}

async function createDirectoryLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
