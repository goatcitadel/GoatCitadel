import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { assertHostAllowed, assertNotPrivateOrReservedHost, assertWritePathInJail } from "@goatcitadel/policy-engine";
import { assertSafeGitPositionalArg } from "./security-utils.js";

// Hardened Git: the one place the Gateway runs the system Git client against a remote address.
//
// Both the Skill Hub's Git review (`skill-import-service.ts`) and plugin sources (`plugin-source-service.ts`) come
// through here. Every command runs with only exact HTTPS transport and no redirects, with a scrubbed environment, and
// never checks a work tree out: files are written from Git objects by bounded reads, so nothing in a fetched tree can
// run, filter or rewrite anything on this computer.

const execFileAsync = promisify(execFile);

const HARDENED_GIT_CONFIG = [
  "protocol.allow=never",
  "protocol.https.allow=always",
  "http.followRedirects=false",
] as const;
export const GIT_MATERIALIZATION_TIMEOUT_MS = 60_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
export const GIT_TREE_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const GIT_METADATA_MAX_BYTES = 16 * 1024 * 1024;
const GIT_METADATA_MAX_ENTRIES = 2_048;
/** How a temp folder is removed: with a few retries, since Windows briefly holds files that were just closed. */
export const TEMP_REMOVAL_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** Files and the folders around them: a tree may hold twice as many entries as files. The one place that ratio lives. */
export function treeEntryLimit(maxFiles: number): number {
  return maxFiles * 2;
}

const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/iu;
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/u;
/** What a forge's Git service says when it won't serve a commit by its id. */
const COMMIT_REFUSAL_PATTERN =
  /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|does not allow request/iu;

export const COMMIT_FETCH_REFUSED_MESSAGE =
  "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag.";

/** The limits a tree is held to: what the Skill Hub's `SKILL_CONTENT_INTEGRITY_LIMITS` and a plugin's limits both fit. */
export interface BoundedGitLimits {
  maxFiles: number;
  /** Files and the folders that hold them. */
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** The class a limit breach is raised as, so each caller keeps its own error type. */
export type GitLimitErrorClass = new (message: string) => Error;

export interface BoundedGitTreeOptions {
  limits: BoundedGitLimits;
  /** Names the tree in messages: "Git skill tree ...", "Git plugin tree ...". */
  label: string;
  limitError: GitLimitErrorClass;
}

export interface MaterializedGitTreeFile {
  objectId: string;
  relativePath: string;
  bytes: number;
}

/** A fetched plugin tree went over its limits. */
export class GitTreeLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitTreeLimitError";
  }
}

/** What `fetchGitTree` was asked for is not something it will fetch: the address, the ref or the limits. */
export class GitFetchInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitFetchInputError";
  }
}

/** The host would not serve the exact commit that was asked for. */
export class GitCommitFetchRefusedError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super(COMMIT_FETCH_REFUSED_MESSAGE, options);
    this.name = "GitCommitFetchRefusedError";
  }
}

/** The address doesn't lead to a public host: it is private, reserved, or didn't resolve. The cause keeps the detail. */
export class GitHostRefusedError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super("That address isn't a public host.", options);
    this.name = "GitHostRefusedError";
  }
}

/**
 * The fetched tree holds something a plugin or skill can't: a link, a submodule, an executable file, a path that isn't
 * portable, or two paths a case-insensitive disk would merge. The message names the path inside the tree, never a path
 * on this computer.
 */
export class GitTreeRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitTreeRefusedError";
  }
}

/**
 * Whether an error came from running `git` rather than from GoatCitadel's own code: a non-zero exit (a numeric `code`),
 * output on `stderr` (every `execFile` failure carries it, as text or as a Buffer), a timeout or an abort. A file
 * system error (a string `code` such as `EPERM`, and no `stderr`) is not one.
 */
export function isGitProcessFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: unknown; killed?: unknown; name?: unknown; stderr?: unknown };
  return (
    typeof failure.code === "number" ||
    failure.stderr !== undefined ||
    failure.killed === true ||
    failure.name === "AbortError"
  );
}

// ---------------------------------------------------------------------------
// Command line and environment
// ---------------------------------------------------------------------------

function gitConfigArgs(extraConfig: readonly string[] = []): string[] {
  return [...HARDENED_GIT_CONFIG, ...extraConfig].flatMap((entry) => ["-c", entry]);
}

export function hardenedGitConfigArgs(): string[] {
  return gitConfigArgs();
}

function buildCloneArgs(
  config: readonly string[],
  sourceRef: string,
  cloneDir: string,
  maxFileBytes: number,
  branch?: string,
): string[] {
  return [
    ...config,
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--no-checkout",
    `--filter=blob:limit=${maxFileBytes + 1}`,
    ...(branch ? ["--branch", branch] : []),
    "--",
    sourceRef,
    cloneDir,
  ];
}

export function buildHardenedGitCloneArgs(sourceRef: string, cloneDir: string, maxFileBytes: number): string[] {
  return buildCloneArgs(gitConfigArgs(), sourceRef, cloneDir, maxFileBytes);
}

export function buildSanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** One deadline for a whole materialization: every Git command in it shares this signal. */
export function startGitDeadline(message: string): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), GIT_MATERIALIZATION_TIMEOUT_MS);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

/** The 60-second runner: one `git` command that talks to a remote, with the arguments already built. */
export async function runGitClone(args: string[], signal: AbortSignal): Promise<void> {
  await execGit(undefined, args, {
    signal,
    encoding: "utf8",
    maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
    timeoutMs: GIT_MATERIALIZATION_TIMEOUT_MS,
  });
}

interface GitRunOptions {
  signal?: AbortSignal;
  encoding: "utf8" | "buffer";
  maxBuffer: number;
  timeoutMs: number;
}

function execGit(cwd: string | undefined, args: string[], options: GitRunOptions) {
  return execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    windowsHide: true,
    env: buildSanitizedGitEnvironment(),
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    encoding: options.encoding === "buffer" ? null : "utf8",
  });
}

function runBoundedGit(
  cwd: string,
  args: string[],
  options: { signal: AbortSignal; encoding: "utf8" | "buffer"; maxBuffer: number },
) {
  return execGit(cwd, [...hardenedGitConfigArgs(), ...args], { ...options, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
}

export async function resolveGitHeadRevision(repoDir: string): Promise<string | undefined> {
  const result = await execFileAsync("git", [...hardenedGitConfigArgs(), "rev-parse", "HEAD"], {
    cwd: repoDir,
    windowsHide: true,
    env: buildSanitizedGitEnvironment(),
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 4_096,
  });
  const stdout = String(result.stdout ?? "").trim();
  return stdout || undefined;
}

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

type GitSourceDnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

// SECURITY (G2-10): the clone runs in a git subprocess outside fetchAllowlisted,
// so apply the same private/loopback/link-local/metadata egress rule up front,
// to the literal host and to every address it resolves to. No operator LAN
// exception is plumbed into this service, so private targets fail closed.
// Git re-resolves the name itself, so this narrows rather than eliminates
// DNS-rebinding; redirects are already disabled in the hardened git config.
export async function assertGitSourceHostIsPublic(
  sourceRef: string,
  lookup: GitSourceDnsLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(sourceRef);
  } catch {
    throw new Error("Git source must be an https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Git source must be an https URL.");
  }
  assertHostAllowed(parsed.toString(), ["*"]);
  // URL keeps IPv6 literals bracketed ("[2606:4700::1]"); strip them so the literal is checked, not resolved.
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) {
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    throw new Error(`Git source host could not be resolved: ${(error as Error).message}`, { cause: error });
  }
  if (addresses.length === 0) {
    throw new Error("Git source host did not resolve to any address.");
  }
  for (const entry of addresses) {
    const literal = entry.address.includes(":") ? `[${entry.address}]` : entry.address;
    assertNotPrivateOrReservedHost(`https://${literal}/`);
  }
}

// ---------------------------------------------------------------------------
// The tree: bounded reads from Git objects, never a checkout
// ---------------------------------------------------------------------------

export async function materializeBoundedGitTree(
  repoDir: string,
  signal: AbortSignal,
  options: BoundedGitTreeOptions,
  destDir: string = repoDir,
): Promise<void> {
  const { limits, label, limitError } = options;
  const listing = await runBoundedGit(repoDir, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    signal,
    encoding: "utf8",
    maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
  });
  const files = parseBoundedGitTree(String(listing.stdout ?? ""), options);
  let totalBytes = 0;
  for (const file of files) {
    const sizeResult = await runBoundedGit(repoDir, ["cat-file", "-s", file.objectId], {
      signal,
      encoding: "utf8",
      maxBuffer: 4_096,
    });
    const rawSize = String(sizeResult.stdout ?? "").trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(rawSize)) {
      throw new limitError(`Git ${label} blob ${file.relativePath} is unavailable inside the bounded partial clone.`);
    }
    const bytes = Number(rawSize);
    if (!Number.isSafeInteger(bytes) || bytes > limits.maxFileBytes) {
      throw new limitError(`Git ${label} blob ${file.relativePath} exceeds ${limits.maxFileBytes} bytes.`);
    }
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new limitError(`Git ${label} tree exceeds ${limits.maxTotalBytes} total bytes.`);
    }
    file.bytes = bytes;
  }

  for (const file of files) {
    const blob = await runBoundedGit(repoDir, ["cat-file", "blob", file.objectId], {
      signal,
      encoding: "buffer",
      maxBuffer: limits.maxFileBytes + 1_024,
    });
    const content = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout ?? "");
    if (content.byteLength !== file.bytes) {
      throw new Error(`Git ${label} blob ${file.relativePath} changed during bounded materialization.`);
    }
    const destination = path.resolve(destDir, ...file.relativePath.split("/"));
    assertWritePathInJail(destination, [destDir]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: "wx" });
  }
}

export function parseBoundedGitTree(output: string, options: BoundedGitTreeOptions): MaterializedGitTreeFile[] {
  const { limits, label, limitError } = options;
  const records = output ? output.split("\0") : [];
  if (records.at(-1) === "") records.pop();
  if (records.length > limits.maxFiles) {
    throw new limitError(`Git ${label} tree exceeds ${limits.maxFiles} files.`);
  }
  const files: MaterializedGitTreeFile[] = [];
  const admitPath = createTreePathTracker(`Git ${label} tree`, limits.maxEntries, limitError);
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator <= 0) throw new Error(`Git ${label} tree returned malformed metadata.`);
    const metadata = record.slice(0, separator).split(" ");
    const relativePath = record.slice(separator + 1);
    const [mode, objectType, objectId] = metadata;
    if (mode !== "100644" || objectType !== "blob" || !/^[a-f0-9]{40}$/u.test(objectId ?? "")) {
      throw new GitTreeRefusedError(
        `Git ${label} tree contains a symlink, submodule, or unsupported object at ${relativePath}.`,
      );
    }
    assertPortableGitTreePath(relativePath, label);
    admitPath(relativePath);
    files.push({ objectId: objectId!, relativePath, bytes: 0 });
  }
  return files;
}

/**
 * Remembers every path a tree has held and refuses the second of two that a case-insensitive disk would merge (two
 * files, two folders, or a file and a folder), a file that is also a folder, and a tree with more files and folders
 * than `maxEntries`. `treeName` opens each message.
 */
export function createTreePathTracker(
  treeName: string,
  maxEntries: number,
  limitError: GitLimitErrorClass,
): (relativePath: string) => void {
  const portablePaths = new Set<string>();
  /** Each folder's lower-cased path, with the spelling it was first seen in. */
  const directories = new Map<string, string>();
  return (relativePath) => {
    const collisionKey = relativePath.toLowerCase();
    if (portablePaths.has(collisionKey) || directories.has(collisionKey)) {
      throw new GitTreeRefusedError(`${treeName} contains a case-colliding path: ${relativePath}.`);
    }
    portablePaths.add(collisionKey);
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const spelling = segments.slice(0, index).join("/");
      const directory = spelling.toLowerCase();
      if (portablePaths.has(directory)) {
        throw new GitTreeRefusedError(`${treeName} contains a file-directory collision: ${relativePath}.`);
      }
      const firstSpelling = directories.get(directory);
      if (firstSpelling !== undefined && firstSpelling !== spelling) {
        throw new GitTreeRefusedError(`${treeName} contains a case-colliding path: ${relativePath}.`);
      }
      directories.set(directory, firstSpelling ?? spelling);
    }
    if (directories.size + portablePaths.size > maxEntries) {
      throw new limitError(`${treeName} exceeds ${maxEntries} filesystem entries.`);
    }
  };
}

export function assertPortableGitTreePath(relativePath: string, label: string): void {
  if (!isPortableTreePath(relativePath)) {
    throw new GitTreeRefusedError(`Git ${label} tree contains a non-portable path: ${relativePath}.`);
  }
}

/** Whether a relative path with `/` separators can be written the same on every disk GoatCitadel runs on. */
export function isPortableTreePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return !(
    !relativePath ||
    relativePath.length > 4_096 ||
    relativePath !== relativePath.normalize("NFKC") ||
    relativePath.includes("\\") ||
    relativePath.includes("\uFFFD") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        containsAsciiControlCharacter(segment) ||
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        segment.toLowerCase() === ".git" ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  );
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export async function assertBoundedGitMetadata(repoDir: string, limitError: GitLimitErrorClass): Promise<void> {
  const objectsDir = path.join(repoDir, ".git", "objects");
  const queue = [objectsDir];
  let entries = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > GIT_METADATA_MAX_ENTRIES) {
        throw new limitError(`Git partial-clone metadata exceeds ${GIT_METADATA_MAX_ENTRIES} entries.`);
      }
      const childPath = path.join(current, child.name);
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) throw new Error("Git partial-clone metadata contains a symbolic link.");
      if (stat.isDirectory()) {
        queue.push(childPath);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes) || bytes > GIT_METADATA_MAX_BYTES) {
          throw new limitError(`Git partial-clone metadata exceeds ${GIT_METADATA_MAX_BYTES} bytes.`);
        }
      } else {
        throw new Error("Git partial-clone metadata contains an unsupported filesystem entry.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fetchGitTree: a Git address (and a commit, branch or tag) into a plain folder
// ---------------------------------------------------------------------------

export interface FetchGitTreeInput {
  url: string;
  /** A 40-hex commit, or a branch or tag. Empty means the default branch. */
  ref?: string;
  /** Where the tree's files are written. Nothing else is written there: no `.git`. */
  destDir: string;
  limits: { maxFiles: number; maxTotalBytes: number; maxFileBytes: number };
}

type GitFetchTarget = { kind: "default" } | { kind: "branch"; ref: string } | { kind: "commit"; commit: string };

interface GitFetchStep {
  name: "clone" | "init" | "remote" | "fetch";
  /** Absent for a clone, which makes its own folder. */
  cwd?: string;
  args: string[];
}

/** What differs between production and the tests' local-repository route. Production adds no setting. */
interface GitTreeFetchPolicy {
  extraConfig: readonly string[];
  /** Checks the address and returns the text to give Git. */
  admitUrl(url: string): Promise<string>;
}

const PRODUCTION_POLICY: GitTreeFetchPolicy = {
  extraConfig: [],
  async admitUrl(rawUrl) {
    const safeUrl = safeGitArgument(rawUrl, "Git source address");
    let parsed: URL;
    try {
      parsed = new URL(safeUrl);
    } catch {
      throw new GitFetchInputError("Git source must be an https URL.");
    }
    if (parsed.protocol !== "https:") throw new GitFetchInputError("Git source must be an https URL.");
    if (parsed.username || parsed.password) {
      throw new GitFetchInputError("Git source must not carry a user name or token.");
    }
    try {
      await assertGitSourceHostIsPublic(parsed.href);
    } catch (error) {
      throw new GitHostRefusedError({ cause: error });
    }
    // Git gets the address as parsed here, not the text it came in as, so both read it the same way.
    return parsed.href;
  },
};

/**
 * Fetches a Git address into `destDir` as plain files and answers the commit that was written.
 *
 * Nothing is checked out and nothing runs: the repository lives next to `destDir` (and is removed), the files come from
 * its objects by bounded reads, and only regular files whose paths are portable are written. A commit is fetched on its
 * own (`git init`, then a depth-1 fetch of that commit), a branch or tag is cloned with `--branch`, and no ref clones
 * the default branch. The answer is the commit actually written. On failure the caller removes `destDir`.
 */
export function fetchGitTree(input: FetchGitTreeInput): Promise<{ commit: string }> {
  return fetchGitTreeUnder(input, PRODUCTION_POLICY);
}

// Test-only route to the same code: it allows the local `file` transport and skips the public-host check, so a bare
// repository on disk can stand in for a forge. `fetchGitTree` has no parameter that does either.
export function __fetchGitTreeForTests(input: FetchGitTreeInput): Promise<{ commit: string }> {
  return fetchGitTreeUnder(input, {
    extraConfig: ["protocol.file.allow=always"],
    admitUrl: async (url) => safeGitArgument(url, "Git source address"),
  });
}

// Test-only projection of the commands production runs for one address and ref (as `fetchGitTree` would build them).
export function __gitTreeFetchArgsForTests(url: string, ref: string | undefined, maxFileBytes = 1024): string[][] {
  return planGitTreeFetch(
    url,
    parseFetchTarget(ref),
    "C:/bounded/repo",
    maxFileBytes,
    PRODUCTION_POLICY.extraConfig,
  ).map((step) => step.args);
}

async function fetchGitTreeUnder(input: FetchGitTreeInput, policy: GitTreeFetchPolicy): Promise<{ commit: string }> {
  const limits = parseFetchLimits(input.limits);
  const target = parseFetchTarget(input.ref);
  const url = await policy.admitUrl(input.url);
  const destDir = path.resolve(input.destDir);
  const repoDir = `${destDir}.git-scratch`;
  const options: BoundedGitTreeOptions = { limits, label: "plugin", limitError: GitTreeLimitError };
  const deadline = startGitDeadline("Git plugin fetch timed out.");
  // The scratch repository is removed only if this call made it: a folder that was already there is not ours.
  let scratchCreated = false;
  try {
    await fs.mkdir(destDir, { recursive: true });
    // Not recursive, so it fails when the folder is already there. A clone is happy to fill a new, empty one.
    await fs.mkdir(repoDir);
    scratchCreated = true;
    for (const step of planGitTreeFetch(url, target, repoDir, limits.maxFileBytes, policy.extraConfig)) {
      await runFetchStep(step, deadline.signal, target);
    }
    if (target.kind === "commit") await pointHeadAtFetchedCommit(repoDir, target.commit, deadline.signal);
    await assertBoundedGitMetadata(repoDir, GitTreeLimitError);
    await materializeBoundedGitTree(repoDir, deadline.signal, options, destDir);
    const commit = await resolveGitHeadRevision(repoDir);
    if (!/^[a-f0-9]{40}$/u.test(commit ?? "") || (target.kind === "commit" && commit !== target.commit)) {
      throw new Error("The fetched Git revision is not the exact commit that was asked for.");
    }
    return { commit: commit! };
  } finally {
    deadline.stop();
    // Best effort: the scratch repository is only scratch, and a failed removal mustn't hide the real result.
    if (scratchCreated) await fs.rm(repoDir, TEMP_REMOVAL_OPTIONS).catch(() => undefined);
  }
}

function planGitTreeFetch(
  url: string,
  target: GitFetchTarget,
  repoDir: string,
  maxFileBytes: number,
  extraConfig: readonly string[],
): GitFetchStep[] {
  const config = gitConfigArgs(extraConfig);
  if (target.kind === "commit") {
    return [
      { name: "init", cwd: repoDir, args: [...config, "init", "--quiet"] },
      { name: "remote", cwd: repoDir, args: [...config, "remote", "add", "--", "origin", url] },
      {
        name: "fetch",
        cwd: repoDir,
        args: [
          ...config,
          "fetch",
          "--quiet",
          "--depth",
          "1",
          "--no-tags",
          `--filter=blob:limit=${maxFileBytes + 1}`,
          "--",
          "origin",
          target.commit,
        ],
      },
    ];
  }
  const branch = target.kind === "branch" ? target.ref : undefined;
  return [{ name: "clone", args: buildCloneArgs(config, url, repoDir, maxFileBytes, branch) }];
}

async function runFetchStep(step: GitFetchStep, signal: AbortSignal, target: GitFetchTarget): Promise<void> {
  try {
    await execGit(step.cwd, step.args, {
      signal,
      encoding: "utf8",
      maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
      timeoutMs: GIT_MATERIALIZATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (step.name === "fetch" && target.kind === "commit" && isCommitRefusal(error)) {
      throw new GitCommitFetchRefusedError({ cause: error });
    }
    throw error;
  }
}

function isCommitRefusal(error: unknown): boolean {
  const failure = error as { killed?: boolean; name?: string; stderr?: unknown };
  if (failure.killed || failure.name === "AbortError") return false;
  return typeof failure.stderr === "string" && COMMIT_REFUSAL_PATTERN.test(failure.stderr);
}

/** Points HEAD at the commit the fetch brought in, so the tree read and the pin both name that commit. */
async function pointHeadAtFetchedCommit(repoDir: string, commit: string, signal: AbortSignal): Promise<void> {
  const resolved = await runBoundedGit(repoDir, ["rev-parse", "--verify", "FETCH_HEAD"], {
    signal,
    encoding: "utf8",
    maxBuffer: 4_096,
  });
  if (String(resolved.stdout ?? "").trim() !== commit) {
    throw new Error("The host sent a different commit from the one that was asked for.");
  }
  await runBoundedGit(repoDir, ["update-ref", "HEAD", commit], { signal, encoding: "utf8", maxBuffer: 4_096 });
}

/** `assertSafeGitPositionalArg`, raised as an input error: an empty value or one Git would read as an option. */
function safeGitArgument(value: string, label: string): string {
  try {
    return assertSafeGitPositionalArg(value, label);
  } catch (error) {
    throw new GitFetchInputError((error as Error).message);
  }
}

function parseFetchTarget(ref: string | undefined): GitFetchTarget {
  const trimmed = ref?.trim();
  if (!trimmed) return { kind: "default" };
  if (GIT_COMMIT_PATTERN.test(trimmed)) return { kind: "commit", commit: trimmed.toLowerCase() };
  if (!GIT_REF_PATTERN.test(trimmed) || trimmed.includes("..")) {
    throw new GitFetchInputError("Git ref must be a full commit, or a branch or tag name.");
  }
  return { kind: "branch", ref: safeGitArgument(trimmed, "Git ref") };
}

function parseFetchLimits(limits: FetchGitTreeInput["limits"]): BoundedGitLimits {
  for (const value of [limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GitFetchInputError("Git tree limits must be positive whole numbers.");
    }
  }
  return { ...limits, maxEntries: treeEntryLimit(limits.maxFiles) };
}
