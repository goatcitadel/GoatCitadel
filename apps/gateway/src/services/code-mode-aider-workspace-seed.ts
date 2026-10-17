import { isUtf8 } from "node:buffer";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CodeModeAiderWorkspaceSeed } from "./code-mode-aider-workspace-pin.js";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  runCodeModeGit,
  runCodeModeGitBuffer,
} from "./code-mode-worktree-capture.js";

/**
 * Seeds a pinned Aider run from the pinned commit. The baseline is a bare Git directory inside the run-temp root
 * (outside the Docker bind mount) whose object store borrows the operator repository's objects through
 * `objects/info/alternates`. Nothing is cloned and nothing is written to the operator repository, its index or its
 * object store: the baseline owns its own index and any new objects `git add` creates.
 *
 * Patch collection rules (all fail closed):
 * - `git add -A -f`: `.gitignore` files (tracked or Aider-written) cannot hide changes. Ignored build output Aider
 *   leaves behind is therefore staged too; the patch byte bound fails such a run closed rather than truncating it.
 * - Aider bookkeeping is excluded by pathspec: the request file, `aider.patch`/`aider.git.patch` and every
 *   `.aider*` path. Edits to a tracked `.aider*` file are therefore dropped from the patch.
 * - Any `.git` entry (directory or gitfile) in the work tree refuses collection, so host-side Git never opens a
 *   nested repository; gitlinks (mode 160000) and new or changed symlinks (mode 120000) are refused after staging.
 * - The diff is captured as bytes and refused unless it is valid UTF-8.
 * The baseline is SHA-1 only: SHA-256 repositories are refused.
 */

export const CODE_MODE_AIDER_BASELINE_GIT_DIR = "aider-baseline.git";
export const CODE_MODE_AIDER_SEED_MAX_FILES = 20_000;
export const CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES = 8 * 1024 * 1024;
/** Git timeout for seeding and patch collection; checkout, add and diff of large trees outlast the capture default. */
export const CODE_MODE_AIDER_SEED_TIMEOUT_MS = 120_000;

const AIDER_PATCH_FILENAMES = ["aider.patch", "aider.git.patch"];
const SEED_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SHA1_COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_COMMIT_ID_PATTERN = /^[0-9a-f]{64}$/u;
const NESTED_GIT_SCAN_MAX_ENTRIES = 200_000;
const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";

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
  const baseCommit = assertSeedableCommitId(input.seed.baseCommit);
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
  await assertNoNestedGitEntries(seeded.workTreeRoot, seeded.pathspec);
  runCodeModeGit(["add", "-A", "-f", "--", ...pathspecs], { ...location, timeoutMs });
  assertNoGitlinkOrSymlinkChanges(
    runCodeModeGit(["diff", "--cached", "--raw", "-z", "--no-renames", seeded.baseCommit, "--", ...pathspecs], {
      ...location,
      timeoutMs,
      maxBuffer: SEED_LIST_MAX_BUFFER_BYTES,
    }),
  );
  let raw: Buffer;
  try {
    raw = runCodeModeGitBuffer(
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
  if (raw.byteLength > CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES) {
    throw new Error(`Aider seeded patch exceeds ${CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES} bytes.`);
  }
  if (!isUtf8(raw)) {
    throw new Error("Aider seeded patch is not valid UTF-8; refusing to record a lossy patch.");
  }
  const content = raw.toString("utf8");
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

function assertSeedableCommitId(value: string): string {
  if (SHA256_COMMIT_ID_PATTERN.test(value)) {
    throw new Error("SHA-256 repositories are not supported for Aider seeding.");
  }
  if (!SHA1_COMMIT_ID_PATTERN.test(value)) {
    throw new Error("Aider workspace seed refuses a pinned commit that is not a full object id.");
  }
  return value;
}

async function assertNoNestedGitEntries(workTreeRoot: string, pathspec: string): Promise<void> {
  const scanRoot = pathspec === "." ? workTreeRoot : path.join(workTreeRoot, ...pathspec.split("/"));
  const pending = [scanRoot];
  let scanned = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === scanRoot) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > NESTED_GIT_SCAN_MAX_ENTRIES) {
        throw new Error(`Aider seeded work tree has more than ${NESTED_GIT_SCAN_MAX_ENTRIES} entries.`);
      }
      if (entry.name.toLowerCase() === ".git") {
        const relPath = path.relative(workTreeRoot, path.join(directory, entry.name)).replaceAll("\\", "/");
        throw new Error(`Aider seeded work tree contains a nested Git entry at ${relPath}; refusing to stage it.`);
      }
      // Dirent types use lstat semantics, so symbolic links to directories are never followed.
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
}

function assertNoGitlinkOrSymlinkChanges(rawZ: string): void {
  const fields = rawZ.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index];
    if (!header?.startsWith(":")) {
      continue;
    }
    const [oldMode, newMode] = header.slice(1).split(" ");
    const relPath = fields[index + 1] ?? "";
    index += 1;
    if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) {
      throw new Error(`Aider seeded patch refuses a gitlink change at ${relPath}.`);
    }
    if (newMode === SYMLINK_MODE) {
      throw new Error(`Aider seeded patch refuses a symbolic link at ${relPath}.`);
    }
  }
}

function assertNoTrackedReservedPath(tracked: string[], reservedRelPaths: string[]): void {
  // NTFS is case-insensitive: on Windows a tracked "Aider/Request.md" would collide with the request file.
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const trackedSet = new Set(tracked.map(fold));
  for (const reserved of reservedRelPaths) {
    const segments = reserved.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      if (trackedSet.has(fold(segments.slice(0, depth).join("/")))) {
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
