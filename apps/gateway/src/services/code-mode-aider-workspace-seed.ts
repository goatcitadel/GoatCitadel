import fs from "node:fs/promises";
import path from "node:path";
import type { CodeModeAiderWorkspaceSeed } from "./code-mode-aider-workspace-pin.js";
import { CODE_MODE_GIT_CAPTURE_TIMEOUT_MS, runCodeModeGit } from "./code-mode-worktree-capture.js";

/**
 * Seeds a pinned Aider run from the pinned commit. The baseline is a bare Git directory inside the run-temp root
 * (outside the Docker bind mount) whose object store borrows the operator repository's objects through
 * `objects/info/alternates`. Nothing is cloned and nothing is written to the operator repository, its index or its
 * object store: the baseline owns its own index and any new objects `git add` creates.
 */

export const CODE_MODE_AIDER_BASELINE_GIT_DIR = "aider-baseline.git";
export const CODE_MODE_AIDER_SEED_MAX_FILES = 20_000;
export const CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES = 8 * 1024 * 1024;

const AIDER_PATCH_FILENAMES = ["aider.patch", "aider.git.patch"];
const SEED_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface SeededCodeModeAiderWorkspace {
  baselineGitDir: string;
  workTreeRoot: string;
  baseCommit: string;
  pathspec: string;
  excludePathspecs: string[];
}

export interface SeededCodeModeAiderPatch {
  kind: "git_patch";
  content: string;
  fileCount: number;
  baseRef: string;
}

export async function seedCodeModeAiderWorkspace(input: {
  seed: CodeModeAiderWorkspaceSeed;
  runTempRoot: string;
  workTreeRoot: string;
  pathspec: string;
  reservedRelPaths: string[];
  timeoutMs?: number;
}): Promise<SeededCodeModeAiderWorkspace> {
  const timeoutMs = input.timeoutMs ?? CODE_MODE_GIT_CAPTURE_TIMEOUT_MS;
  const baselineGitDir = path.join(input.runTempRoot, CODE_MODE_AIDER_BASELINE_GIT_DIR);
  assertDisjoint(baselineGitDir, input.workTreeRoot);
  const baseCommit = input.seed.baseCommit;
  if (!COMMIT_ID_PATTERN.test(baseCommit)) {
    throw new Error("Aider workspace seed refuses a pinned commit that is not a full object id.");
  }
  const pathspec = normalizeSeedRelPath(input.pathspec);
  const reservedRelPaths = input.reservedRelPaths.map(normalizeSeedRelPath);

  const operatorObjectsDir = resolveOperatorObjectsDir(input.seed.worktreePath, timeoutMs);
  await fs.mkdir(input.runTempRoot, { recursive: true });
  await fs.mkdir(baselineGitDir);
  runCodeModeGit(["init", "--bare", "--quiet", "--template=", baselineGitDir], {
    cwd: input.runTempRoot,
    timeoutMs,
  });
  await fs.mkdir(path.join(baselineGitDir, "objects", "info"), { recursive: true });
  await fs.writeFile(path.join(baselineGitDir, "objects", "info", "alternates"), `${operatorObjectsDir}\n`, "utf8");

  try {
    runCodeModeGit(["cat-file", "-e", `${baseCommit}^{commit}`], { gitDir: baselineGitDir, timeoutMs });
  } catch (error) {
    throw new Error("Aider workspace seed pinned commit is not available in the operator repository.", {
      cause: error,
    });
  }
  const tracked = runCodeModeGit(["ls-tree", "-r", "--name-only", "-z", baseCommit, "--", toTopPathspec(pathspec)], {
    gitDir: baselineGitDir,
    timeoutMs,
    maxBuffer: SEED_LIST_MAX_BUFFER_BYTES,
  })
    .split("\0")
    .filter(Boolean);
  if (tracked.length > CODE_MODE_AIDER_SEED_MAX_FILES) {
    throw new Error(
      `Aider workspace seed refuses a pinned commit with more than ${CODE_MODE_AIDER_SEED_MAX_FILES} tracked files.`,
    );
  }
  assertNoTrackedReservedPath(tracked, reservedRelPaths);

  await fs.mkdir(input.workTreeRoot, { recursive: true });
  if (tracked.length > 0) {
    runCodeModeGit(["checkout", "--quiet", baseCommit, "--", toTopPathspec(pathspec)], {
      gitDir: baselineGitDir,
      workTree: input.workTreeRoot,
      timeoutMs,
    });
  }
  return {
    baselineGitDir,
    workTreeRoot: input.workTreeRoot,
    baseCommit,
    pathspec,
    excludePathspecs: buildExcludePathspecs(pathspec, reservedRelPaths),
  };
}

/**
 * Stages the work tree into the baseline-local index and diffs it against the pinned commit. The pathspec
 * restriction is mandatory; Aider bookkeeping (request file, explicit patch files, `.aider*`) is always excluded.
 */
export async function collectSeededCodeModeAiderPatch(
  seeded: SeededCodeModeAiderWorkspace,
  options: { timeoutMs?: number } = {},
): Promise<SeededCodeModeAiderPatch | undefined> {
  const timeoutMs = options.timeoutMs ?? CODE_MODE_GIT_CAPTURE_TIMEOUT_MS;
  const location = { gitDir: seeded.baselineGitDir, workTree: seeded.workTreeRoot };
  const pathspecs = [toTopPathspec(seeded.pathspec), ...seeded.excludePathspecs];
  runCodeModeGit(["add", "-A", "--", ...pathspecs], { ...location, timeoutMs });
  let content: string;
  try {
    content = runCodeModeGit(
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        seeded.baseCommit,
        "--",
        ...pathspecs,
      ],
      { ...location, timeoutMs, maxBuffer: CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES + 1 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      throw new Error(`Aider seeded patch exceeds ${CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES} bytes.`, { cause: error });
    }
    throw error;
  }
  if (Buffer.byteLength(content, "utf8") > CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES) {
    throw new Error(`Aider seeded patch exceeds ${CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES} bytes.`);
  }
  if (!content.trim()) {
    return undefined;
  }
  return {
    kind: "git_patch",
    content,
    fileCount: content.match(/^diff --git /gmu)?.length ?? 0,
    baseRef: seeded.baseCommit,
  };
}

function resolveOperatorObjectsDir(worktreePath: string, timeoutMs: number): string {
  const commonDir = runCodeModeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: worktreePath,
    timeoutMs,
  }).trim();
  if (!commonDir || !path.isAbsolute(commonDir)) {
    throw new Error("Aider workspace seed could not resolve the operator repository object store.");
  }
  return `${commonDir.replaceAll("\\", "/").replace(/\/+$/u, "")}/objects`;
}

function buildExcludePathspecs(pathspec: string, reservedRelPaths: string[]): string[] {
  const patchPaths = AIDER_PATCH_FILENAMES.flatMap((filename) =>
    pathspec === "." ? [filename] : [filename, path.posix.join(pathspec, filename)],
  );
  const literalExcludes = [...new Set([...reservedRelPaths, ...patchPaths])].map(
    (relPath) => `:(top,exclude,literal)${relPath}`,
  );
  return [...literalExcludes, ":(top,exclude,glob)**/.aider*", ":(top,exclude,glob)**/.aider*/**"];
}

function assertNoTrackedReservedPath(tracked: string[], reservedRelPaths: string[]): void {
  const trackedSet = new Set(tracked);
  for (const reserved of reservedRelPaths) {
    const segments = reserved.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      if (trackedSet.has(segments.slice(0, depth).join("/"))) {
        throw new Error(`Aider workspace seed refuses a pinned commit that tracks the reserved path ${reserved}.`);
      }
    }
  }
}

function assertDisjoint(baselineGitDir: string, workTreeRoot: string): void {
  if (isPathInside(baselineGitDir, workTreeRoot) || isPathInside(workTreeRoot, baselineGitDir)) {
    throw new Error("Aider workspace seed refuses a baseline Git directory inside the work tree.");
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toTopPathspec(relPath: string): string {
  return relPath === "." ? ":(top)" : `:(top,literal)${relPath}`;
}

function normalizeSeedRelPath(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (!normalized || normalized === ".") {
    return ".";
  }
  if (path.posix.isAbsolute(normalized) || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Aider workspace seed paths must stay inside the run work tree.");
  }
  return normalized;
}
