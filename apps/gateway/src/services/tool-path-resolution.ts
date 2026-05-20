import fs from "node:fs";
import path from "node:path";
import { ValidationError, type ToolInvokeRequest } from "@goatcitadel/contracts";

export interface ToolPathResolutionContext {
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
}

const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";

type PathResolutionKind = "read" | "write" | "cwd";

interface ToolPathSpec {
  key: string;
  kind: PathResolutionKind;
  injectDefault?: boolean;
  when?: (request: ToolInvokeRequest) => boolean;
}

const TOOL_PATH_SPECS: Record<string, ToolPathSpec[]> = {
  "fs.read": [{ key: "path", kind: "read" }],
  "file.read_range": [{ key: "path", kind: "read" }],
  "file.find": [{ key: "path", kind: "read" }],
  "code.search": [{ key: "path", kind: "read" }],
  "code.search_files": [{ key: "path", kind: "read" }],
  "fs.write": [{ key: "path", kind: "write" }],
  "fs.list": [{ key: "path", kind: "read", injectDefault: true }],
  "fs.stat": [{ key: "path", kind: "read", injectDefault: true }],
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
  "docs.ingest": [{ key: "source", kind: "read", when: (request) => request.args.sourceType === "file" }],
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
    if (spec.when && !spec.when(request)) {
      continue;
    }
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

export function resolveProjectRootForToolContext(input: {
  workspaceRoot: string;
  repoRoot: string;
  projectWorkspacePath?: string;
}): string | undefined {
  const projectWorkspacePath = input.projectWorkspacePath?.trim();
  if (!projectWorkspacePath) {
    return undefined;
  }
  if (projectWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
    return path.resolve(input.repoRoot);
  }
  return path.resolve(input.workspaceRoot, projectWorkspacePath);
}

function resolveRelativeToolPath(
  rawPath: string,
  context: ToolPathResolutionContext,
  kind: PathResolutionKind,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return rawPath;
  }
  if (path.isAbsolute(trimmed)) {
    return resolveAbsoluteToolPath(trimmed, context, kind);
  }

  if (isDotPath(trimmed)) {
    return context.projectRoot ?? path.resolve(context.workspaceRoot);
  }

  const workspaceCandidate = path.resolve(context.workspaceRoot, trimmed);
  const projectRelativePath = normalizeProjectRelativeInput(trimmed, context.projectWorkspacePath);
  const projectCandidate = context.projectRoot ? path.resolve(context.projectRoot, projectRelativePath) : undefined;
  if (!projectCandidate) {
    return finalizeResolvedToolPath(workspaceCandidate, trimmed, context, kind);
  }

  if (shouldPreferWorkspaceRoot(trimmed, context.projectWorkspacePath)) {
    if (candidateLooksValid(workspaceCandidate, kind, context)) {
      return finalizeResolvedToolPath(workspaceCandidate, trimmed, context, kind);
    }
    if (candidateLooksValid(projectCandidate, kind, context)) {
      return finalizeResolvedToolPath(projectCandidate, trimmed, context, kind);
    }
    return finalizeResolvedToolPath(workspaceCandidate, trimmed, context, kind);
  }

  if (candidateLooksValid(projectCandidate, kind, context)) {
    return finalizeResolvedToolPath(projectCandidate, trimmed, context, kind);
  }
  if (candidateLooksValid(workspaceCandidate, kind, context)) {
    return finalizeResolvedToolPath(workspaceCandidate, trimmed, context, kind);
  }

  return finalizeResolvedToolPath(projectCandidate, trimmed, context, kind);
}

function resolveAbsoluteToolPath(
  rawPath: string,
  context: ToolPathResolutionContext,
  kind: PathResolutionKind,
): string {
  const absoluteTarget = path.resolve(rawPath);
  if (isFilesystemRootPath(absoluteTarget)) {
    if (kind === "cwd") {
      return defaultToolCwd(context);
    }
    throw new ValidationError({
      message: `Path "${rawPath}" resolves to the filesystem root and is not allowed for ${kind} operations.`,
    });
  }

  const resolvedTarget = resolvePathViaExistingAncestor(absoluteTarget);
  if (isWithinWorkspaceBounds(resolvedTarget, context)) {
    return resolvedTarget;
  }
  if (kind === "read") {
    return resolvedTarget;
  }

  throw new ValidationError({
    message: `Path "${rawPath}" is outside the workspace boundary and is not allowed.`,
  });
}

function candidateLooksValid(candidate: string, kind: PathResolutionKind, context: ToolPathResolutionContext): boolean {
  try {
    const resolvedCandidate = resolvePathViaExistingAncestor(candidate);
    if (!isWithinWorkspaceBounds(resolvedCandidate, context)) {
      return false;
    }
    if (!fs.existsSync(candidate)) {
      if (kind !== "write") {
        return false;
      }
      return fs.existsSync(path.dirname(candidate));
    }
    if (kind !== "cwd") {
      return true;
    }
    return fs.statSync(resolvedCandidate).isDirectory();
  } catch {
    return false;
  }
}

function isWithinWorkspaceBounds(resolvedPath: string, context: ToolPathResolutionContext): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  return (
    isWithinRoot(context.workspaceRoot, normalizedPath) ||
    (context.projectRoot ? isWithinRoot(context.projectRoot, normalizedPath) : false)
  );
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
  return normalizedRawPath === normalizedProjectPath || normalizedRawPath.startsWith(`${normalizedProjectPath}/`);
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

function isFilesystemRootPath(value: string): boolean {
  const parsed = path.parse(value);
  return parsed.root === value;
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolvePathViaExistingAncestor(targetPath: string): string {
  const absoluteTarget = path.resolve(targetPath);
  let probe = absoluteTarget;

  while (true) {
    if (fs.existsSync(probe)) {
      const realExisting = fs.realpathSync(probe);
      if (probe === absoluteTarget) {
        return realExisting;
      }
      const relativeTail = path.relative(probe, absoluteTarget);
      return path.resolve(realExisting, relativeTail);
    }

    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  return absoluteTarget;
}

function finalizeResolvedToolPath(
  candidate: string,
  rawPath: string,
  context: ToolPathResolutionContext,
  kind: PathResolutionKind,
): string {
  const resolvedCandidate = resolvePathViaExistingAncestor(candidate);
  if (!isWithinWorkspaceBounds(resolvedCandidate, context)) {
    if (kind === "read") {
      return resolvedCandidate;
    }
    throw new ValidationError({
      message: `Path "${rawPath}" is outside the workspace boundary and is not allowed for ${kind} operations.`,
    });
  }
  return candidate;
}

function defaultToolCwd(context: ToolPathResolutionContext): string {
  return context.projectRoot ?? path.resolve(context.workspaceRoot);
}
