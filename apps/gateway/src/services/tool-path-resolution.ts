import fs from "node:fs";
import path from "node:path";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";

export interface ToolPathResolutionContext {
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
}

type PathResolutionKind = "read" | "write" | "cwd";

interface ToolPathSpec {
  key: string;
  kind: PathResolutionKind;
  injectDefault?: boolean;
}

const TOOL_PATH_SPECS: Record<string, ToolPathSpec[]> = {
  "fs.read": [{ key: "path", kind: "read" }],
  "file.read_range": [{ key: "path", kind: "read" }],
  "file.find": [{ key: "path", kind: "read" }],
  "code.search": [{ key: "path", kind: "read" }],
  "code.search_files": [{ key: "path", kind: "read" }],
  "fs.write": [{ key: "path", kind: "write" }],
  "fs.list": [{ key: "path", kind: "read" }],
  "fs.stat": [{ key: "path", kind: "read" }],
  "fs.copy": [
    { key: "from", kind: "read" },
    { key: "to", kind: "write" },
  ],
  "fs.move": [
    { key: "from", kind: "write" },
    { key: "to", kind: "write" },
  ],
  "fs.delete": [{ key: "path", kind: "write" }],
  "shell.exec": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "shell.exec_background": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "tests.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "lint.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "build.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "git.worktree.create": [{ key: "path", kind: "write" }],
  "git.worktree.remove": [{ key: "path", kind: "write" }],
};

export function resolveToolRequestPaths(
  request: ToolInvokeRequest,
  context: ToolPathResolutionContext,
): ToolInvokeRequest {
  const specs = TOOL_PATH_SPECS[request.toolName];
  if (!specs || specs.length === 0) {
    return request;
  }

  let nextArgs: Record<string, unknown> | undefined;
  for (const spec of specs) {
    const rawValue = request.args[spec.key];
    if (typeof rawValue !== "string") {
      if (rawValue === undefined && spec.injectDefault) {
        nextArgs ??= { ...request.args };
        nextArgs[spec.key] = defaultToolCwd(context);
      }
      continue;
    }
    const resolvedValue = resolveRelativeToolPath(rawValue, context, spec.kind);
    if (resolvedValue === rawValue) {
      continue;
    }
    nextArgs ??= { ...request.args };
    nextArgs[spec.key] = resolvedValue;
  }

  if (!nextArgs) {
    return request;
  }

  return {
    ...request,
    args: nextArgs,
  };
}

function resolveRelativeToolPath(
  rawPath: string,
  context: ToolPathResolutionContext,
  kind: PathResolutionKind,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return rawPath;
  }

  if (isDotPath(trimmed)) {
    return context.projectRoot ?? path.resolve(context.workspaceRoot);
  }

  const workspaceCandidate = path.resolve(context.workspaceRoot, trimmed);
  const projectRelativePath = normalizeProjectRelativeInput(trimmed, context.projectWorkspacePath);
  const projectCandidate = context.projectRoot ? path.resolve(context.projectRoot, projectRelativePath) : undefined;
  if (!projectCandidate) {
    return workspaceCandidate;
  }

  if (shouldPreferWorkspaceRoot(trimmed, context.projectWorkspacePath)) {
    if (candidateLooksValid(workspaceCandidate, kind)) {
      return workspaceCandidate;
    }
    if (candidateLooksValid(projectCandidate, kind)) {
      return projectCandidate;
    }
    return workspaceCandidate;
  }

  if (candidateLooksValid(projectCandidate, kind)) {
    return projectCandidate;
  }
  if (candidateLooksValid(workspaceCandidate, kind)) {
    return workspaceCandidate;
  }

  return projectCandidate;
}

function candidateLooksValid(candidate: string, kind: PathResolutionKind): boolean {
  try {
    if (!fs.existsSync(candidate)) {
      if (kind !== "write") {
        return false;
      }
      return fs.existsSync(path.dirname(candidate));
    }
    if (kind !== "cwd") {
      return true;
    }
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function shouldPreferWorkspaceRoot(rawPath: string, projectWorkspacePath?: string): boolean {
  if (!projectWorkspacePath) {
    return true;
  }
  const normalizedRawPath = normalizeRelativePath(rawPath);
  const normalizedProjectPath = normalizeRelativePath(projectWorkspacePath);
  if (!normalizedProjectPath) {
    return true;
  }
  return normalizedRawPath === normalizedProjectPath
    || normalizedRawPath.startsWith(`${normalizedProjectPath}/`);
}

function normalizeProjectRelativeInput(rawPath: string, projectWorkspacePath?: string): string {
  if (!projectWorkspacePath) {
    return rawPath;
  }
  const normalizedRawPath = normalizeRelativePath(rawPath);
  const normalizedProjectPath = normalizeRelativePath(projectWorkspacePath);
  const projectBaseName = normalizedProjectPath.split("/").at(-1);
  if (!projectBaseName) {
    return rawPath;
  }
  if (normalizedRawPath === projectBaseName) {
    return ".";
  }
  if (normalizedRawPath.startsWith(`${projectBaseName}/`)) {
    return normalizedRawPath.slice(projectBaseName.length + 1);
  }
  return rawPath;
}

function normalizeRelativePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isDotPath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  return normalized === "" || normalized === ".";
}

function defaultToolCwd(context: ToolPathResolutionContext): string {
  return context.projectRoot ?? path.resolve(context.workspaceRoot);
}
