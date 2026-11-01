import fs from "node:fs";
import path from "node:path";
import { ValidationError, type ToolAccessEvaluateRequest, type ToolInvokeRequest } from "@goatcitadel/contracts";

export interface ToolPathResolutionContext {
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
  /**
   * Extra roots that absolute write paths may target besides the workspace and
   * project: the runtime write jail plus admitted operator write roots. The
   * policy engine and executor stay the authority (deny-wins, approvals,
   * hard-forbidden paths); this only stops the gateway from rejecting a path
   * the policy would admit. Never applies to reads or cwd.
   */
  writeRoots?: readonly string[];
  /**
   * "defer_to_policy" passes absolute write targets outside every root through
   * unchanged for tools that may ask the operator (outside-root write
   * approvals), so the policy engine decides instead of this resolver. Only set
   * for ordinary sessions when the operator opted in; relative escapes and
   * filesystem roots are still rejected here.
   */
  outsideRootWrites?: "reject" | "defer_to_policy";
  /**
   * When set, every write target must also land inside one of these roots;
   * the project root alone does not admit it. Set for delegated child sessions
   * without an approved scope, so a project folder inside an operator write
   * root cannot widen their writes.
   */
  confineWritesTo?: readonly string[];
}

const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";

type PathResolutionKind = "read" | "write" | "cwd";

interface ToolPathSpec {
  key: string;
  kind: PathResolutionKind;
  injectDefault?: boolean;
  /**
   * A relative path that starts with the workspace folder's own name (the
   * documented `./workspace/artifacts/...` form for artifact and browser
   * outputs) resolves against the runtime root, so it lands inside the
   * workspace instead of in a nested `workspace/workspace` folder.
   */
  workspaceDirPrefix?: boolean;
  /** An absolute target outside every root may be deferred to policy (outside-root write approvals). */
  deferOutsideRoot?: boolean;
  when?: (request: ToolPathRequest) => boolean;
}

const OUTPUT_PATH_SPEC: ToolPathSpec = { key: "path", kind: "write", workspaceDirPrefix: true, deferOutsideRoot: true };
const BROWSER_OUTPUT_PATH_SPECS: ToolPathSpec[] = [
  { key: "outputPath", kind: "write", workspaceDirPrefix: true, deferOutsideRoot: true },
  OUTPUT_PATH_SPEC,
];

export type ToolPathRequest = ToolInvokeRequest | ToolAccessEvaluateRequest;

const TOOL_PATH_SPECS: Record<string, ToolPathSpec[]> = {
  "fs.read": [{ key: "path", kind: "read" }],
  "file.read_range": [{ key: "path", kind: "read" }],
  "file.find": [{ key: "path", kind: "read" }],
  "code.search": [{ key: "path", kind: "read" }],
  "code.search_files": [{ key: "path", kind: "read" }],
  "fs.write": [{ key: "path", kind: "write", deferOutsideRoot: true }],
  "fs.patch": [{ key: "path", kind: "write", deferOutsideRoot: true }],
  "artifacts.create": [OUTPUT_PATH_SPEC],
  "documents.create": [OUTPUT_PATH_SPEC],
  "presentations.create": [OUTPUT_PATH_SPEC],
  "browser.screenshot": BROWSER_OUTPUT_PATH_SPECS,
  "browser.interact": BROWSER_OUTPUT_PATH_SPECS,
  "fs.list": [{ key: "path", kind: "read", injectDefault: true }],
  "fs.stat": [{ key: "path", kind: "read", injectDefault: true }],
  "fs.copy": [
    { key: "from", kind: "read" },
    { key: "to", kind: "write", deferOutsideRoot: true },
  ],
  "fs.move": [
    { key: "from", kind: "write" },
    { key: "to", kind: "write", deferOutsideRoot: true },
  ],
  "fs.delete": [{ key: "path", kind: "write" }],
  "shell.exec": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "shell.exec_background": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "tests.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "lint.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "build.run": [{ key: "cwd", kind: "cwd", injectDefault: true }],
  "docs.ingest": [{ key: "source", kind: "read", when: (request) => request.args?.sourceType === "file" }],
  "docs.read_bytes": [{ key: "path", kind: "read" }],
  "docs.extract_text": [{ key: "path", kind: "read" }],
  "docs.decompress": [{ key: "path", kind: "read" }],
  "git.worktree.create": [{ key: "path", kind: "write" }],
  "git.worktree.remove": [{ key: "path", kind: "write" }],
};

export function resolveToolRequestPaths<TRequest extends ToolPathRequest>(
  request: TRequest,
  context: ToolPathResolutionContext,
): TRequest {
  const specs = TOOL_PATH_SPECS[request.toolName];
  if (!specs || specs.length === 0) {
    return request;
  }

  const args = request.args ?? {};
  let nextArgs: Record<string, unknown> | undefined;
  for (const spec of specs) {
    if (spec.when && !spec.when(request)) {
      continue;
    }
    const rawValue = args[spec.key];
    if (typeof rawValue !== "string") {
      if (rawValue === undefined && spec.injectDefault) {
        nextArgs ??= { ...args };
        nextArgs[spec.key] = defaultToolCwd(context);
      }
      continue;
    }
    const resolvedValue =
      spec.workspaceDirPrefix && startsWithWorkspaceDirName(rawValue, context)
        ? finalizeResolvedToolPath(
            path.resolve(path.dirname(path.resolve(context.workspaceRoot)), rawValue.trim()),
            rawValue.trim(),
            context,
            spec.kind,
          )
        : resolveRelativeToolPath(
            rawValue,
            context,
            spec.kind,
            spec.deferOutsideRoot === true && context.outsideRootWrites === "defer_to_policy",
          );
    if (spec.kind === "write") {
      assertWriteWithinConfinement(resolvedValue, rawValue, context);
    }
    if (resolvedValue === rawValue) {
      continue;
    }
    nextArgs ??= { ...args };
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
  deferOutsideRoot = false,
): string {
  // Cross-runtime cwd values must reach the execution bridge byte-for-byte.
  // In particular, path.resolve() on Windows would reinterpret /mnt/c, /c,
  // drive-relative, UNC, and device-like values before their source flavor and
  // safety posture can be established. Preserve the broad absolute-like set;
  // the fresh post-hook bridge is the authority that accepts or rejects it.
  if (kind === "cwd" && isWorkspacePathBridgeAbsoluteLikeCwd(rawPath)) {
    return rawPath;
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return rawPath;
  }
  if (path.isAbsolute(trimmed)) {
    return resolveAbsoluteToolPath(trimmed, context, kind, deferOutsideRoot);
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

export function isWorkspacePathBridgeAbsoluteLikeCwd(value: string): boolean {
  const candidate = value.trim();
  return /^[A-Za-z]:/u.test(candidate) || /^[\\/]/u.test(candidate);
}

function resolveAbsoluteToolPath(
  rawPath: string,
  context: ToolPathResolutionContext,
  kind: PathResolutionKind,
  deferOutsideRoot = false,
): string {
  const absoluteTarget = path.resolve(rawPath);
  if (isFilesystemRootPath(absoluteTarget)) {
    if (kind === "cwd") {
      return defaultToolCwd(context);
    }
    throw new ValidationError({
      message: `Path "${rawPath}" resolves to the filesystem root and is not allowed for ${kind} operations. Use a relative path such as "." to target the project root.`,
    });
  }

  const resolvedTarget = resolvePathViaExistingAncestor(absoluteTarget);
  if (isWithinWorkspaceBounds(resolvedTarget, context)) {
    return absoluteTarget;
  }
  if (kind === "read") {
    return resolvedTarget;
  }
  if (kind === "write" && isWithinWriteRoots(resolvedTarget, context)) {
    return absoluteTarget;
  }
  if (kind === "write" && deferOutsideRoot) {
    // Outside-root write approvals: the policy engine and executor decide.
    return absoluteTarget;
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
    isWithinAnyRootVariant(context.workspaceRoot, normalizedPath) ||
    (context.projectRoot ? isWithinAnyRootVariant(context.projectRoot, normalizedPath) : false)
  );
}

function isWithinWriteRoots(resolvedPath: string, context: ToolPathResolutionContext): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  return (context.writeRoots ?? []).some((root) => isWithinAnyRootVariant(root, normalizedPath));
}

function assertWriteWithinConfinement(
  resolvedValue: string,
  rawPath: string,
  context: ToolPathResolutionContext,
): void {
  const roots = context.confineWritesTo;
  if (!roots) {
    return;
  }
  const resolvedTarget = resolvePathViaExistingAncestor(resolvedValue.trim());
  if (!roots.some((root) => isWithinAnyRootVariant(root, resolvedTarget))) {
    throw new ValidationError({
      message: `Path "${rawPath}" is outside the workspace boundary and is not allowed for write operations.`,
    });
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

function startsWithWorkspaceDirName(rawPath: string, context: ToolPathResolutionContext): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return false;
  }
  const workspaceDirName = path.basename(path.resolve(context.workspaceRoot));
  const firstSegment = normalizeRelativePath(trimmed).split("/")[0];
  return Boolean(workspaceDirName) && firstSegment === workspaceDirName;
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

function isWithinAnyRootVariant(root: string, target: string): boolean {
  return rootVariantsForComparison(root).some((rootVariant) => isWithinRoot(rootVariant, target));
}

function rootVariantsForComparison(root: string): string[] {
  const resolvedRoot = path.resolve(root);
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    return realRoot === resolvedRoot ? [resolvedRoot] : [resolvedRoot, realRoot];
  } catch {
    return [resolvedRoot];
  }
}

const MAX_DANGLING_LINK_HOPS = 40;

/**
 * Resolve a path through its nearest existing ancestor. A dangling link (one
 * whose target does not exist yet) is followed to its target instead of being
 * skipped, since a write through it would land there; too many hops (a link
 * cycle) refuses the path.
 */
function resolvePathViaExistingAncestor(targetPath: string): string {
  let absoluteTarget = path.resolve(targetPath);
  for (let hop = 0; hop <= MAX_DANGLING_LINK_HOPS; hop += 1) {
    const step = resolveThroughNearestExistingAncestor(absoluteTarget);
    if (step.danglingLinkTarget === undefined) {
      return step.resolved;
    }
    absoluteTarget = step.danglingLinkTarget;
  }
  throw new ValidationError({
    message: `Path "${targetPath}" passes through too many symbolic links and is not allowed.`,
  });
}

function lstatOrUndefined(probe: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(probe);
  } catch {
    return undefined;
  }
}

function resolveThroughNearestExistingAncestor(absoluteTarget: string): {
  resolved: string;
  danglingLinkTarget?: string;
} {
  let probe = absoluteTarget;
  while (true) {
    const stats = lstatOrUndefined(probe);
    if (stats) {
      const relativeTail = path.relative(probe, absoluteTarget);
      if (stats.isSymbolicLink() && !fs.existsSync(probe)) {
        const linkTarget = path.resolve(path.dirname(probe), fs.readlinkSync(probe));
        return { resolved: absoluteTarget, danglingLinkTarget: path.resolve(linkTarget, relativeTail) };
      }
      return { resolved: path.resolve(fs.realpathSync(probe), relativeTail) };
    }

    const parent = path.dirname(probe);
    if (parent === probe) {
      return { resolved: absoluteTarget };
    }
    probe = parent;
  }
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
    if (kind === "write" && isWithinWriteRoots(resolvedCandidate, context)) {
      return candidate;
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
