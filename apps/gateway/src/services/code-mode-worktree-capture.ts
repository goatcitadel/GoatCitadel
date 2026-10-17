import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile, execFileSync, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import type { AsyncStorage } from "@goatcitadel/storage";

/**
 * Shared Git/worktree capture plumbing for Code Mode verification and the Aider workspace pin.
 * Moved verbatim from code-mode-verification-service.ts; the state-hash formula must stay stable because
 * recorded verification evidence and workspace pins compare against it.
 */

export const CODE_MODE_GIT_CAPTURE_TIMEOUT_MS = 15_000;
/**
 * The Chat workbench patch byte limit. Seeded Aider patch collection and promotion share it so a patch Code Mode
 * records is never larger than the workbench will accept.
 */
export const CODE_MODE_WORKBENCH_PATCH_MAX_BYTES = 4 * 1024 * 1024;
const MAX_GIT_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_FILES_IN_EVIDENCE = 200;
const OUTSIDE_ROOT_MARKER = "[outside-root]";

export interface CodeModeWorktreeCapture {
  identityHash: string;
  stateHash: string;
  baseRef?: string;
  headHash?: string;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  valid: boolean;
  reasons: string[];
  /** Canonical (realpath) worktree location; present only when the capture resolved a ready worktree. */
  worktreePath?: string;
}

export interface CodeModeGitWorktreeState {
  headHash: string;
  stateHash: string;
  changedFiles: string[];
  changedFilesTruncated: boolean;
}

export interface CodeModeGitRunOptions {
  cwd?: string;
  gitDir?: string;
  workTree?: string;
  timeoutMs: number;
  maxBuffer?: number;
}

/**
 * `asyncGit` runs the Git capture without blocking the event loop (same argv, env and hash formula). Verification
 * keeps the default synchronous capture.
 */
export async function captureCodeModeWorkbenchWorktree(
  storage: Pick<AsyncStorage, "chatSessionWorkbench">,
  binding: { sessionId?: string; runId: string },
  timeoutMs: number,
  options: { rootDir?: string; asyncGit?: boolean } = {},
): Promise<CodeModeWorktreeCapture> {
  const fallbackIdentity = sha256(JSON.stringify({ sessionId: binding.sessionId ?? null, runId: binding.runId }));
  if (!binding.sessionId) {
    return unavailableWorktree(fallbackIdentity, "worktree_session_missing");
  }
  const workbench = await storage.chatSessionWorkbench.get(binding.sessionId);
  if (
    !workbench?.worktreePath ||
    workbench.worktreeStatus !== "ready" ||
    workbench.worktreePath === OUTSIDE_ROOT_MARKER
  ) {
    return unavailableWorktree(fallbackIdentity, "worktree_not_ready", workbench?.baseRef);
  }
  try {
    const realWorktreePath = fs.realpathSync(path.resolve(options.rootDir ?? process.cwd(), workbench.worktreePath));
    const identityHash = sha256(
      JSON.stringify({
        sessionId: binding.sessionId,
        projectId: workbench.projectId ?? null,
        path: normalizePath(realWorktreePath),
      }),
    );
    const state = options.asyncGit
      ? await captureCodeModeGitWorktreeStateAsync(realWorktreePath, timeoutMs)
      : captureCodeModeGitWorktreeState(realWorktreePath, timeoutMs);
    return {
      identityHash,
      stateHash: state.stateHash,
      baseRef: workbench.baseRef,
      headHash: state.headHash,
      changedFiles: state.changedFiles,
      changedFilesTruncated: state.changedFilesTruncated,
      valid: true,
      reasons: [],
      worktreePath: realWorktreePath,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...unavailableWorktree(fallbackIdentity, "worktree_state_unavailable", workbench.baseRef),
      stateHash: sha256(detail),
    };
  }
}

/**
 * `statusExcludePaths` (worktree-root-relative, matched literally) drops paths from the status listing only, so a
 * caller holding a lock file inside the tree reproduces the hash of the same tree without that file. Without it the
 * Git argv, and therefore the formula, is unchanged.
 */
export function captureCodeModeGitWorktreeState(
  worktreePath: string,
  timeoutMs: number,
  options: { statusExcludePaths?: readonly string[] } = {},
): CodeModeGitWorktreeState {
  const commands = buildWorktreeStateCommands(options.statusExcludePaths);
  const run = (args: string[]) => runCodeModeGit(args, { cwd: worktreePath, timeoutMs });
  return deriveWorktreeState(worktreePath, run(commands.head).trim(), run(commands.status), run(commands.diff));
}

/** {@link captureCodeModeGitWorktreeState} on the asynchronous Git runner: identical commands, order and formula. */
export async function captureCodeModeGitWorktreeStateAsync(
  worktreePath: string,
  timeoutMs: number,
  options: { statusExcludePaths?: readonly string[] } = {},
): Promise<CodeModeGitWorktreeState> {
  const commands = buildWorktreeStateCommands(options.statusExcludePaths);
  const run = async (args: string[]) => await runCodeModeGitAsync(args, { cwd: worktreePath, timeoutMs });
  const headHash = (await run(commands.head)).trim();
  const statusRaw = await run(commands.status);
  const diffRaw = await run(commands.diff);
  return deriveWorktreeState(worktreePath, headHash, statusRaw, diffRaw);
}

function buildWorktreeStateCommands(statusExcludePaths: readonly string[] | undefined): {
  head: string[];
  status: string[];
  diff: string[];
} {
  const statusExcludes = (statusExcludePaths ?? []).map((entry) => `:(exclude,literal)${entry}`);
  const statusPathspec = statusExcludes.length > 0 ? ["--", ".", ...statusExcludes] : [];
  return {
    head: ["rev-parse", "HEAD"],
    status: ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...statusPathspec],
    diff: ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD", "--", "."],
  };
}

function deriveWorktreeState(
  worktreePath: string,
  headHash: string,
  statusRaw: string,
  diffRaw: string,
): CodeModeGitWorktreeState {
  const statusEntries = statusRaw.split("\0").filter(Boolean);
  const changedFiles = statusEntries
    .map((entry) => entry.slice(3).replaceAll("\\", "/"))
    .filter(Boolean)
    .sort();
  const untrackedDigests = statusEntries
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => hashUntrackedEntry(worktreePath, entry.slice(3)))
    .sort((left, right) => left.path.localeCompare(right.path));
  const stateHash = sha256(
    JSON.stringify({
      headHash,
      statusSha256: sha256(statusRaw),
      diffSha256: sha256(diffRaw),
      untrackedDigests,
    }),
  );
  return {
    headHash,
    stateHash,
    changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES_IN_EVIDENCE),
    changedFilesTruncated: changedFiles.length > MAX_CHANGED_FILES_IN_EVIDENCE,
  };
}

/**
 * Runs Git with the hardened, config-isolated invocation used for capture. The `cwd` form produces the same argv
 * as the original verification `runGit`; the `gitDir`/`workTree` form addresses a separate Git directory.
 */
export function runCodeModeGit(args: string[], options: CodeModeGitRunOptions): string {
  return execFileSync("git", [...resolveGitLocationArgs(options), ...CODE_MODE_GIT_HARDENING_ARGS, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? MAX_GIT_CAPTURE_BYTES,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    env: buildSanitizedGitEnvironment(),
  });
}

/** Same hardened invocation as {@link runCodeModeGit}, returning raw stdout bytes for callers that must not decode. */
export function runCodeModeGitBuffer(args: string[], options: CodeModeGitRunOptions): Buffer {
  return execFileSync("git", [...resolveGitLocationArgs(options), ...CODE_MODE_GIT_HARDENING_ARGS, ...args], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? MAX_GIT_CAPTURE_BYTES,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    env: buildSanitizedGitEnvironment(),
  });
}

/**
 * Asynchronous {@link runCodeModeGit}: the same argv, hardening args, sanitized environment, `maxBuffer`, timeout
 * with SIGKILL and `windowsHide`, without blocking the event loop. A `maxBuffer` overflow rejects with
 * `code: "ENOBUFS"` and a timeout with `code: "ETIMEDOUT"`, as the synchronous runner does.
 */
export async function runCodeModeGitAsync(args: string[], options: CodeModeGitRunOptions): Promise<string> {
  return (await runCodeModeGitBufferAsync(args, options)).toString("utf8");
}

/** Asynchronous {@link runCodeModeGitBuffer}; see {@link runCodeModeGitAsync}. */
export async function runCodeModeGitBufferAsync(args: string[], options: CodeModeGitRunOptions): Promise<Buffer> {
  const argv = [...resolveGitLocationArgs(options), ...CODE_MODE_GIT_HARDENING_ARGS, ...args];
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "git",
      argv,
      {
        encoding: "buffer",
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? MAX_GIT_CAPTURE_BYTES,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        env: buildSanitizedGitEnvironment(),
      },
      (error, stdout) => {
        if (error) {
          reject(normalizeAsyncGitError(error));
          return;
        }
        resolve(stdout);
      },
    );
    // execFileSync gives the child an empty stdin; close the pipe so Git never waits on input.
    child.stdin?.end();
  });
}

function normalizeAsyncGitError(error: ExecFileException): Error {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return Object.assign(new Error(`Code Mode Git output exceeded maxBuffer: ${error.message}`, { cause: error }), {
      code: "ENOBUFS",
    });
  }
  if (error.killed && error.signal === "SIGKILL") {
    return Object.assign(new Error(`Code Mode Git timed out: ${error.message}`, { cause: error }), {
      code: "ETIMEDOUT",
    });
  }
  return error;
}

const CODE_MODE_GIT_HARDENING_ARGS: readonly string[] = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "-c",
  "interactive.diffFilter=",
];

function resolveGitLocationArgs(options: CodeModeGitRunOptions): string[] {
  if (options.cwd !== undefined) {
    if (options.gitDir !== undefined || options.workTree !== undefined) {
      throw new Error("Code Mode Git invocation takes either cwd or gitDir/workTree, not both.");
    }
    return ["-C", options.cwd];
  }
  if (options.gitDir === undefined) {
    throw new Error("Code Mode Git invocation requires cwd or gitDir.");
  }
  return [
    `--git-dir=${options.gitDir}`,
    ...(options.workTree !== undefined ? [`--work-tree=${options.workTree}`] : []),
  ];
}

function unavailableWorktree(identityHash: string, reason: string, baseRef?: string): CodeModeWorktreeCapture {
  return {
    identityHash,
    stateHash: sha256(reason),
    baseRef,
    changedFiles: [],
    changedFilesTruncated: false,
    valid: false,
    reasons: [reason],
  };
}

function hashUntrackedEntry(
  worktreePath: string,
  relativePath: string,
): { path: string; sha256: string; bytes: number } {
  const normalized = relativePath.replaceAll("\\", "/");
  const targetPath = path.resolve(worktreePath, relativePath);
  assertPathInside(targetPath, worktreePath);
  const content = readContainedRegularFile(targetPath, worktreePath, MAX_CAPTURED_FILE_BYTES);
  if (content.byteLength > MAX_CAPTURED_FILE_BYTES) {
    throw new Error(`Untracked file ${normalized} exceeds the verification bound.`);
  }
  return { path: normalized, sha256: sha256(content), bytes: content.byteLength };
}

function buildSanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_EXTERNAL_DIFF: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function readContainedRegularFile(candidate: string, root: string, maxBytes: number): Buffer {
  const lexicalCandidate = path.resolve(candidate);
  const lexicalRoot = path.resolve(root);
  assertPathInside(lexicalCandidate, lexicalRoot);
  const lexicalStat = fs.lstatSync(lexicalCandidate);
  if (lexicalStat.isSymbolicLink()) {
    throw new Error("Verification refuses symbolic-link artifacts and worktree entries.");
  }
  const canonicalRoot = fs.realpathSync(lexicalRoot);
  const canonicalCandidate = fs.realpathSync(lexicalCandidate);
  assertPathInside(canonicalCandidate, canonicalRoot);
  const canonicalStat = fs.statSync(canonicalCandidate);
  if (!canonicalStat.isFile() || canonicalStat.size > maxBytes) {
    throw new Error("Verification file is missing, not regular, or exceeds the byte bound.");
  }
  return fs.readFileSync(canonicalCandidate);
}

export function assertPathInside(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Verification path escaped its managed root.");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
