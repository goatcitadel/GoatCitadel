import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { resolveToolRequestPaths } from "./tool-path-resolution.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveToolRequestPaths", () => {
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

  it("re-anchors filesystem root placeholders back to the assigned project root", async () => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "code.search_files",
      args: { path: path.parse(workspaceRoot).root, query: "package.json" },
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
});

async function createWorkspaceFixture(): Promise<{ workspaceRoot: string; projectRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-tool-paths-"));
  tempRoots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "fixtures", "prompt-pack-workspace");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "utils.ts"), "export const slugify = () => '';\n", "utf8");
  return { workspaceRoot, projectRoot };
}
