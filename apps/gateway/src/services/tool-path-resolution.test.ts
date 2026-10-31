import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError, type ToolInvokeRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import { resolveProjectRootForToolContext, resolveToolRequestPaths } from "./tool-path-resolution.js";
import { resolveToolRequestPathsForSessionScope, type SessionToolPathScopeDeps } from "./tool-path-session-scope.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveToolRequestPaths", () => {
  it.each(["docs.read_bytes", "docs.extract_text", "docs.decompress"])(
    "anchors a relative %s path to the workspace root, as fs.read does",
    async (toolName) => {
      const { workspaceRoot } = await createWorkspaceFixture();
      const request: ToolInvokeRequest = {
        toolName,
        args: { path: "artifacts/plan.pdf" },
        agentId: "agent",
        sessionId: "session",
      };

      const resolved = resolveToolRequestPaths(request, { workspaceRoot });

      expect(resolved.args.path).toBe(path.join(workspaceRoot, "artifacts", "plan.pdf"));
    },
  );

  it("leaves a docs helper request that names an attachment unchanged", () => {
    const request: ToolInvokeRequest = {
      toolName: "docs.extract_text",
      args: { attachmentId: "att_1" },
      agentId: "agent",
      sessionId: "session",
    };

    expect(resolveToolRequestPaths(request, { workspaceRoot: os.tmpdir() })).toBe(request);
  });

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

  it("preserves filesystem roots for the fresh execution bridge to reject", async () => {
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

    expect(resolved.args.cwd).toBe(path.parse(workspaceRoot).root);
  });

  it.each(["shell.exec", "shell.exec_background", "tests.run", "lint.run", "build.run"])(
    "preserves exact cross-flavor cwd bytes for %s",
    async (toolName) => {
      const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
      for (const cwd of ["F:/Work Space/Project", "/f/Work Space\\Project", "/mnt/f/Work Space/Project"]) {
        const request: ToolInvokeRequest = {
          toolName,
          args: { cwd, command: "pwd" },
          agentId: "agent",
          sessionId: "session",
        };

        const resolved = resolveToolRequestPaths(request, {
          workspaceRoot,
          projectRoot,
          projectWorkspacePath: "fixtures/prompt-pack-workspace",
        });

        expect(resolved.args.cwd).toBe(cwd);
      }
    },
  );

  it.each([
    "F:drive-relative",
    "F:\\Work Space\\Project:stream",
    "\\\\?\\F:\\Work Space\\Project",
    "\\\\server\\share\\Project",
    "F:\\Work Space\\..\\Other",
    "F:\\Work Space\\Project\u0000suffix",
  ])("does not normalize unsafe absolute-like cwd %j before bridge validation", async (cwd) => {
    const { projectRoot, workspaceRoot } = await createWorkspaceFixture();
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { cwd, command: "pwd" },
      agentId: "agent",
      sessionId: "session",
    };

    const resolved = resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });

    expect(resolved.args.cwd).toBe(cwd);
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

describe("resolveToolRequestPaths write roots", () => {
  function writeRequest(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
    return { toolName, args, agentId: "agent", sessionId: "session" };
  }

  it("accepts absolute write and delete targets inside configured write roots", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const target = path.join(outsideRoot, "stale.tmp");

    for (const toolName of ["fs.write", "fs.delete"]) {
      const resolved = resolveToolRequestPaths(writeRequest(toolName, { path: target }), {
        workspaceRoot,
        writeRoots: [outsideRoot],
      });
      expect(resolved.args.path).toBe(target);
    }
  });

  it("still rejects absolute writes outside the workspace and every write root", async () => {
    const { repoRoot, workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    const elsewhere = path.join(repoRoot, "elsewhere", "file.txt");
    expect(() =>
      resolveToolRequestPaths(writeRequest("fs.write", { path: elsewhere }), {
        workspaceRoot,
        writeRoots: [outsideRoot],
      }),
    ).toThrow(/outside the workspace boundary/);
    expect(() =>
      resolveToolRequestPaths(writeRequest("fs.write", { path: path.join(outsideRoot, "x.txt") }), { workspaceRoot }),
    ).toThrow(/outside the workspace boundary/);
  });

  it("accepts a relative link from the workspace into a write root but not elsewhere", async () => {
    const { workspaceRoot, outsideRoot, repoRoot } = await createWorkspaceFixture();
    await createDirectoryLink(outsideRoot, path.join(workspaceRoot, "linked-root"));
    const resolved = resolveToolRequestPaths(writeRequest("fs.write", { path: "linked-root/new.txt" }), {
      workspaceRoot,
      writeRoots: [outsideRoot],
    });
    expect(resolved.args.path).toBe(path.join(workspaceRoot, "linked-root", "new.txt"));

    const otherDir = path.join(repoRoot, "other");
    await fs.mkdir(otherDir, { recursive: true });
    await createDirectoryLink(otherDir, path.join(workspaceRoot, "linked-other"));
    expect(() =>
      resolveToolRequestPaths(writeRequest("fs.write", { path: "linked-other/new.txt" }), {
        workspaceRoot,
        writeRoots: [outsideRoot],
      }),
    ).toThrow(ValidationError);
  });

  it("does not let write roots widen cwd resolution", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceFixture();
    await createDirectoryLink(outsideRoot, path.join(workspaceRoot, "linked-cwd"));
    expect(() =>
      resolveToolRequestPaths(writeRequest("shell.exec", { command: "dir", cwd: "linked-cwd" }), {
        workspaceRoot,
        writeRoots: [outsideRoot],
      }),
    ).toThrow(ValidationError);
  });
});

describe("resolveToolRequestPaths artifact, patch, and browser outputs", () => {
  function outputRequest(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
    return { toolName, args, agentId: "agent", sessionId: "session" };
  }

  it("resolves relative output paths against the workspace instead of the process directory", async () => {
    const { workspaceRoot } = await createWorkspaceFixture();
    for (const toolName of ["fs.patch", "artifacts.create", "documents.create", "presentations.create"]) {
      const resolved = resolveToolRequestPaths(outputRequest(toolName, { path: "reports/out.md" }), {
        workspaceRoot,
      });
      expect(resolved.args.path, toolName).toBe(path.join(workspaceRoot, "reports", "out.md"));
    }
    for (const toolName of ["browser.screenshot", "browser.interact"]) {
      const resolved = resolveToolRequestPaths(
        outputRequest(toolName, { url: "https://example.com", outputPath: "shots/a.png", path: "shots/b.png" }),
        { workspaceRoot },
      );
      expect(resolved.args.outputPath, toolName).toBe(path.join(workspaceRoot, "shots", "a.png"));
      expect(resolved.args.path, toolName).toBe(path.join(workspaceRoot, "shots", "b.png"));
    }
  });

  it("keeps the documented ./workspace/artifacts form inside the workspace, with or without a project", async () => {
    const { workspaceRoot, projectRoot } = await createWorkspaceFixture();
    const expected = path.join(workspaceRoot, "artifacts", "report.docx");
    for (const context of [
      { workspaceRoot },
      { workspaceRoot, projectRoot, projectWorkspacePath: "fixtures/prompt-pack-workspace" },
    ]) {
      const document = resolveToolRequestPaths(
        outputRequest("documents.create", { path: "./workspace/artifacts/report.docx", title: "Report" }),
        context,
      );
      expect(document.args.path).toBe(expected);
      const shot = resolveToolRequestPaths(
        outputRequest("browser.screenshot", {
          url: "https://example.com",
          outputPath: "workspace/artifacts/report.docx",
        }),
        context,
      );
      expect(shot.args.outputPath).toBe(expected);
    }
  });

  it("leaves a browser screenshot without an output path to its default location", async () => {
    const { workspaceRoot } = await createWorkspaceFixture();
    const request = outputRequest("browser.screenshot", { url: "https://example.com" });
    expect(resolveToolRequestPaths(request, { workspaceRoot })).toBe(request);
  });

  it("routes a relative fs.patch target into the assigned project root", async () => {
    const { workspaceRoot, projectRoot } = await createWorkspaceFixture();
    const resolved = resolveToolRequestPaths(outputRequest("fs.patch", { path: "src/utils.ts" }), {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: "fixtures/prompt-pack-workspace",
    });
    expect(resolved.args.path).toBe(path.join(projectRoot, "src", "utils.ts"));
  });

  it("rejects relative output paths that climb out of the workspace", async () => {
    const { workspaceRoot } = await createWorkspaceFixture();
    for (const [toolName, key] of [
      ["artifacts.create", "path"],
      ["browser.interact", "outputPath"],
      ["documents.create", "path"],
    ] as const) {
      expect(() =>
        resolveToolRequestPaths(outputRequest(toolName, { [key]: "../outside/escape.md" }), { workspaceRoot }),
      ).toThrow(ValidationError);
      expect(() =>
        resolveToolRequestPaths(outputRequest(toolName, { [key]: "workspace/../../escape.md" }), { workspaceRoot }),
      ).toThrow(ValidationError);
    }
  });
});

describe("resolveToolRequestPaths outside-root write deferral", () => {
  function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
    return { toolName, args, agentId: "agent", sessionId: "session" };
  }

  it("passes absolute outside writes through unchanged only when deferring to policy", async () => {
    const { workspaceRoot, repoRoot } = await createWorkspaceFixture();
    const target = path.join(repoRoot, "elsewhere", "out.txt");
    for (const toolName of ["fs.write", "fs.patch", "artifacts.create", "documents.create", "presentations.create"]) {
      const deferred = resolveToolRequestPaths(request(toolName, { path: target }), {
        workspaceRoot,
        outsideRootWrites: "defer_to_policy",
      });
      expect(deferred.args.path).toBe(target);
    }
    expect(() =>
      resolveToolRequestPaths(request("fs.write", { path: target }), { workspaceRoot, outsideRootWrites: "reject" }),
    ).toThrow(/outside the workspace boundary/u);
    expect(() => resolveToolRequestPaths(request("fs.write", { path: target }), { workspaceRoot })).toThrow(
      /outside the workspace boundary/u,
    );
  });

  it("defers copy and move destinations and browser outputs, but never deletes or move sources", async () => {
    const { workspaceRoot, repoRoot } = await createWorkspaceFixture();
    const outsideFile = path.join(repoRoot, "elsewhere", "x.txt");
    const inside = path.join(workspaceRoot, "inside.txt");
    const context = { workspaceRoot, outsideRootWrites: "defer_to_policy" as const };
    expect(resolveToolRequestPaths(request("fs.copy", { from: inside, to: outsideFile }), context).args.to).toBe(
      outsideFile,
    );
    expect(resolveToolRequestPaths(request("fs.move", { from: inside, to: outsideFile }), context).args.to).toBe(
      outsideFile,
    );
    expect(
      resolveToolRequestPaths(request("browser.screenshot", { outputPath: outsideFile }), context).args.outputPath,
    ).toBe(outsideFile);
    expect(() => resolveToolRequestPaths(request("fs.delete", { path: outsideFile }), context)).toThrow(
      /outside the workspace boundary/u,
    );
    expect(() => resolveToolRequestPaths(request("fs.move", { from: outsideFile, to: inside }), context)).toThrow(
      /outside the workspace boundary/u,
    );
  });

  it("still rejects relative escapes and filesystem roots while deferring", async () => {
    const { workspaceRoot } = await createWorkspaceFixture();
    const context = { workspaceRoot, outsideRootWrites: "defer_to_policy" as const };
    expect(() => resolveToolRequestPaths(request("fs.write", { path: "../../escape.txt" }), context)).toThrow(
      ValidationError,
    );
    expect(() =>
      resolveToolRequestPaths(request("fs.write", { path: path.parse(workspaceRoot).root }), context),
    ).toThrow(/filesystem root/u);
  });
});

describe("resolveToolRequestPathsForSessionScope", () => {
  function sandboxFor(jailRoot: string, operatorRoot: string): ToolPolicyConfig["sandbox"] {
    return {
      writeJailRoots: [jailRoot],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
      operatorWriteRoots: [{ path: operatorRoot, allowDelete: true }],
      runtimeWriteProtection: { rootDir: path.dirname(jailRoot), protectedPaths: [] },
    };
  }

  function storageFor(delegated: boolean): SessionToolPathScopeDeps["storage"] {
    return {
      chatSessionProjects: { get: async () => undefined },
      chatProjects: { find: async () => undefined },
      chatDelegationSteps: {
        listParentsByChildSessionIds: async () => new Map(delegated ? [["session", { stepId: "step-1" }]] : []),
        get: async () => ({ scopeControl: { rootPath: "", approvedPaths: ["."] } }),
      },
    } as unknown as SessionToolPathScopeDeps["storage"];
  }

  it("defers outside-root writes for ordinary sessions only when the operator opted in", async () => {
    const { repoRoot, outsideRoot } = await createWorkspaceFixture();
    const jailRoot = path.join(repoRoot, "data");
    const elsewhere = path.join(repoRoot, "elsewhere", "out.txt");
    const write = { toolName: "fs.write", args: { path: elsewhere }, agentId: "agent", sessionId: "session" };
    const optedIn = { ...sandboxFor(jailRoot, outsideRoot), outsideRootWriteMode: "approval_required" as const };
    const ordinary: SessionToolPathScopeDeps = {
      rootDir: repoRoot,
      workspaceDir: "workspace",
      sandbox: optedIn,
      storage: storageFor(false),
    };
    expect((await resolveToolRequestPathsForSessionScope(write, ordinary)).args.path).toBe(elsewhere);

    const notOptedIn = { ...ordinary, sandbox: sandboxFor(jailRoot, outsideRoot) };
    await expect(resolveToolRequestPathsForSessionScope(write, notOptedIn)).rejects.toThrow(
      /outside the workspace boundary/u,
    );

    const delegatedWithoutScope: SessionToolPathScopeDeps["storage"] = {
      chatSessionProjects: { get: async () => undefined },
      chatProjects: { find: async () => undefined },
      chatDelegationSteps: {
        listParentsByChildSessionIds: async () => new Map([["session", { stepId: "step-1" }]]),
        get: async () => ({ scopeControl: undefined }),
      },
    } as unknown as SessionToolPathScopeDeps["storage"];
    await expect(
      resolveToolRequestPathsForSessionScope(write, { ...ordinary, storage: delegatedWithoutScope }),
    ).rejects.toThrow(/outside the workspace boundary/u);
  });

  it("lets ordinary sessions write by absolute path into jail and operator roots", async () => {
    const { repoRoot, outsideRoot } = await createWorkspaceFixture();
    const jailRoot = path.join(repoRoot, "data");
    await fs.mkdir(jailRoot, { recursive: true });
    const deps: SessionToolPathScopeDeps = {
      rootDir: repoRoot,
      workspaceDir: "workspace",
      sandbox: sandboxFor(jailRoot, outsideRoot),
      storage: storageFor(false),
    };

    for (const target of [path.join(jailRoot, "a.txt"), path.join(outsideRoot, "b.txt")]) {
      const resolved = await resolveToolRequestPathsForSessionScope(
        { toolName: "fs.delete", args: { path: target }, agentId: "agent", sessionId: "session" },
        deps,
      );
      expect(resolved.args.path).toBe(target);
    }
  });

  it("keeps delegated child sessions confined to their approved scope", async () => {
    const { repoRoot, outsideRoot } = await createWorkspaceFixture();
    const deps: SessionToolPathScopeDeps = {
      rootDir: repoRoot,
      workspaceDir: "workspace",
      sandbox: sandboxFor(path.join(repoRoot, "data"), outsideRoot),
      storage: storageFor(true),
    };
    await expect(
      resolveToolRequestPathsForSessionScope(
        {
          toolName: "fs.delete",
          args: { path: path.join(outsideRoot, "b.txt") },
          agentId: "agent",
          sessionId: "session",
        },
        deps,
      ),
    ).rejects.toThrow(/outside the workspace boundary/);
  });
});

describe("resolveToolRequestPathsForSessionScope operator write roots for delegated children (D8)", () => {
  interface Fixture {
    repoRoot: string;
    jailRoot: string;
    operatorRoot: string;
    operatorProjectRoot: string;
    sandbox: ToolPolicyConfig["sandbox"];
  }

  async function createFixture(): Promise<Fixture> {
    const { repoRoot, outsideRoot } = await createWorkspaceFixture();
    const jailRoot = path.join(repoRoot, "data");
    const operatorProjectRoot = path.join(outsideRoot, "project");
    await fs.mkdir(jailRoot, { recursive: true });
    await fs.mkdir(operatorProjectRoot, { recursive: true });
    return {
      repoRoot,
      jailRoot,
      operatorRoot: outsideRoot,
      operatorProjectRoot,
      sandbox: {
        writeJailRoots: [jailRoot],
        readOnlyRoots: [],
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
        operatorWriteRoots: [{ path: outsideRoot, allowDelete: true }],
        runtimeWriteProtection: { rootDir: repoRoot, protectedPaths: [] },
        outsideRootWriteMode: "approval_required",
      },
    };
  }

  function storageFor(input: {
    projectWorkspacePath?: string;
    delegation: "none" | "unscoped" | { rootPath: string } | "parents_lookup_fails" | "step_lookup_fails";
  }): SessionToolPathScopeDeps["storage"] {
    const { delegation } = input;
    return {
      chatSessionProjects: {
        get: async () => (input.projectWorkspacePath ? { projectId: "project-1" } : undefined),
      },
      chatProjects: {
        find: async () => (input.projectWorkspacePath ? { workspacePath: input.projectWorkspacePath } : undefined),
      },
      chatDelegationSteps: {
        listParentsByChildSessionIds: async () => {
          if (delegation === "parents_lookup_fails") throw new Error("storage unavailable");
          return new Map(delegation === "none" ? [] : [["session", { stepId: "step-1" }]]);
        },
        get: async () => {
          if (delegation === "step_lookup_fails") throw new Error("step missing");
          return typeof delegation === "object"
            ? { scopeControl: { rootPath: delegation.rootPath, approvedPaths: ["."] } }
            : { scopeControl: undefined };
        },
      },
    } as unknown as SessionToolPathScopeDeps["storage"];
  }

  function depsFor(fixture: Fixture, storage: SessionToolPathScopeDeps["storage"]): SessionToolPathScopeDeps {
    return { rootDir: fixture.repoRoot, workspaceDir: "workspace", sandbox: fixture.sandbox, storage };
  }

  function writeRequest(toolName: string, target: string) {
    return { toolName, args: { path: target }, agentId: "agent", sessionId: "session" };
  }

  it("refuses absolute writes into operator roots for a delegated child without a scope", async () => {
    const fixture = await createFixture();
    const deps = depsFor(fixture, storageFor({ delegation: "unscoped" }));
    for (const toolName of ["fs.write", "fs.delete"]) {
      await expect(
        resolveToolRequestPathsForSessionScope(writeRequest(toolName, path.join(fixture.operatorRoot, "b.txt")), deps),
      ).rejects.toThrow(/outside the workspace boundary/u);
    }
    const jailTarget = path.join(fixture.jailRoot, "a.txt");
    expect((await resolveToolRequestPathsForSessionScope(writeRequest("fs.write", jailTarget), deps)).args.path).toBe(
      jailTarget,
    );
  });

  it("refuses writes through a project folder inside an operator root for a delegated child without a scope", async () => {
    const fixture = await createFixture();
    const deps = depsFor(
      fixture,
      storageFor({ delegation: "unscoped", projectWorkspacePath: fixture.operatorProjectRoot }),
    );
    await expect(resolveToolRequestPathsForSessionScope(writeRequest("fs.write", "notes.txt"), deps)).rejects.toThrow(
      /outside the workspace boundary/u,
    );
    await expect(
      resolveToolRequestPathsForSessionScope(
        writeRequest("fs.write", path.join(fixture.operatorProjectRoot, "notes.txt")),
        deps,
      ),
    ).rejects.toThrow(/outside the workspace boundary/u);
    const read = await resolveToolRequestPathsForSessionScope(writeRequest("fs.read", "notes.txt"), deps);
    expect(read.args.path).toBe(path.join(fixture.operatorProjectRoot, "notes.txt"));
  });

  it("admits only the approved scope for a delegated child whose scope lies inside an operator root", async () => {
    const fixture = await createFixture();
    const deps = depsFor(fixture, storageFor({ delegation: { rootPath: fixture.operatorProjectRoot } }));
    const scopedTarget = path.join(fixture.operatorProjectRoot, "notes.txt");
    const resolved = await resolveToolRequestPathsForSessionScope(writeRequest("fs.write", scopedTarget), deps);
    expect(resolved.args.path).toBe(scopedTarget);
    await expect(
      resolveToolRequestPathsForSessionScope(writeRequest("fs.write", path.join(fixture.operatorRoot, "b.txt")), deps),
    ).rejects.toThrow(/outside the workspace boundary/u);
  });

  it("follows a dangling link into an operator root for a delegated child without a scope", async () => {
    const fixture = await createFixture();
    const workspaceRoot = path.join(fixture.repoRoot, "workspace");
    await createDirectoryLink(path.join(fixture.operatorRoot, "not-yet"), path.join(workspaceRoot, "dangling"));
    const deps = depsFor(fixture, storageFor({ delegation: "unscoped" }));
    for (const target of ["dangling/notes.txt", path.join(workspaceRoot, "dangling", "notes.txt")]) {
      await expect(resolveToolRequestPathsForSessionScope(writeRequest("fs.write", target), deps)).rejects.toThrow(
        /outside the workspace boundary/u,
      );
    }
  });

  it("refuses a write through a link cycle", async () => {
    const fixture = await createFixture();
    const workspaceRoot = path.join(fixture.repoRoot, "workspace");
    const first = path.join(workspaceRoot, "loop-a");
    const second = path.join(workspaceRoot, "loop-b");
    await createDirectoryLink(second, first);
    await createDirectoryLink(first, second);
    const deps = depsFor(fixture, storageFor({ delegation: "unscoped" }));
    await expect(
      resolveToolRequestPathsForSessionScope(writeRequest("fs.write", path.join(first, "notes.txt")), deps),
    ).rejects.toThrow(ValidationError);
  });

  it("keeps operator roots and project folders inside them for ordinary sessions", async () => {
    const fixture = await createFixture();
    const deps = depsFor(
      fixture,
      storageFor({ delegation: "none", projectWorkspacePath: fixture.operatorProjectRoot }),
    );
    const relative = await resolveToolRequestPathsForSessionScope(writeRequest("fs.write", "notes.txt"), deps);
    expect(relative.args.path).toBe(path.join(fixture.operatorProjectRoot, "notes.txt"));
    const operatorTarget = path.join(fixture.operatorRoot, "b.txt");
    const absolute = await resolveToolRequestPathsForSessionScope(writeRequest("fs.delete", operatorTarget), deps);
    expect(absolute.args.path).toBe(operatorTarget);
  });

  it.each(["parents_lookup_fails", "step_lookup_fails"] as const)(
    "fails closed when the delegation lookup fails (%s)",
    async (delegation) => {
      const fixture = await createFixture();
      const deps = depsFor(fixture, storageFor({ delegation }));
      const error = await resolveToolRequestPathsForSessionScope(
        writeRequest("fs.write", path.join(fixture.jailRoot, "a.txt")),
        deps,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/delegation scope/u);
    },
  );
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
