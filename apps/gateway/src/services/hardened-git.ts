import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { isPortablePluginPath } from "@goatcitadel/contracts";
import { assertHostAllowed, assertNotPrivateOrReservedHost, assertWritePathInJail } from "@goatcitadel/policy-engine";
import { createGitBatchRunner, readBoundedBlobContents, readBoundedBlobSizes } from "./hardened-git-batch.js";
import {
  PARTIAL_CLONE_METADATA_WORDING,
  labelledGitTreeWording,
  type GitMetadataWording,
  type GitTreeWording,
} from "./hardened-git-wording.js";
import {
  COMMIT_FETCH_REFUSED_MESSAGE,
  GIT_FETCH_FAILURE_MESSAGES,
  GIT_INPUT_MESSAGES,
  HOST_NOT_PUBLIC_MESSAGE,
  HOST_UNREACHABLE_MESSAGE,
  PLUGIN_GIT_TREE_WORDING,
} from "./plugin-git-messages.js";
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

export { COMMIT_FETCH_REFUSED_MESSAGE, labelledGitTreeWording, type GitMetadataWording, type GitTreeWording };

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
  /** Words for each refusal in place of the label's. The skill import gives none, so its messages stay as they were. */
  wording?: GitTreeWording;
}

function treeWording(options: BoundedGitTreeOptions): GitTreeWording {
  return options.wording ?? labelledGitTreeWording(options.label);
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

/** The address doesn't lead to a public host: it is private, loopback, metadata or reserved. The cause keeps the detail. */
export class GitHostRefusedError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super(HOST_NOT_PUBLIC_MESSAGE, options);
    this.name = "GitHostRefusedError";
  }
}

/** The address's host name didn't resolve, or resolved to nothing. The cause is the `HostLookupError`. */
export class GitHostLookupError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super(HOST_UNREACHABLE_MESSAGE, options);
    this.name = "GitHostLookupError";
  }
}

/**
 * Git, or the host behind it, sent something GoatCitadel can't use: a commit other than the one asked for, a file list
 * it can't read, a file whose size changed between two reads, or a repository whose own files hold a link. It is the
 * remote's doing, not a fault here. The message is a fixed sentence, in the caller's own words.
 */
export class GitFetchFailedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitFetchFailedError";
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

/** Every address a host name resolves to. */
export type HostAddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

/** The system resolver, asked for every address in the order it gives them. */
export const lookUpHostAddresses: HostAddressLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** A host name that didn't resolve (`unresolved`, with the resolver's error as `cause`) or resolved to nothing. */
export class HostLookupError extends Error {
  public constructor(
    public readonly kind: "unresolved" | "no_address",
    options?: { cause?: unknown },
  ) {
    super(
      kind === "unresolved" ? "The host could not be resolved." : "The host did not resolve to any address.",
      options,
    );
    this.name = "HostLookupError";
  }
}

/** The host is private, loopback, link-local, metadata or reserved. `cause` is the network guard's own refusal. */
export class HostNotPublicError extends Error {
  public constructor(options: { cause: unknown }) {
    super("The host isn't a public host.", options);
    this.name = "HostNotPublicError";
  }
}

/**
 * Refuses a host that is private, loopback, link-local, metadata or reserved: the literal in `url`, and, for a name,
 * every address it resolves to. A refused host is a `HostNotPublicError` (with the network guard's error as its cause);
 * a name that doesn't resolve, or resolves to nothing, is a `HostLookupError`. The URL's scheme is the caller's to
 * check.
 */
export async function assertHostResolvesPublic(
  url: URL,
  lookup: HostAddressLookup = lookUpHostAddresses,
): Promise<void> {
  refuseUnlessPublic(() => assertHostAllowed(url.toString(), ["*"]));
  // URL keeps IPv6 literals bracketed ("[2606:4700::1]"); strip them so the literal is checked, not resolved.
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) {
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    throw new HostLookupError("unresolved", { cause: error });
  }
  if (addresses.length === 0) {
    throw new HostLookupError("no_address");
  }
  for (const entry of addresses) {
    const literal = entry.address.includes(":") ? `[${entry.address}]` : entry.address;
    refuseUnlessPublic(() => assertNotPrivateOrReservedHost(`https://${literal}/`));
  }
}

/** Runs one of the network guard's checks, turning its refusal into a `HostNotPublicError`. */
function refuseUnlessPublic(check: () => void): void {
  try {
    check();
  } catch (error) {
    throw new HostNotPublicError({ cause: error });
  }
}

// SECURITY (G2-10): the clone runs in a git subprocess outside fetchAllowlisted,
// so apply the same private/loopback/link-local/metadata egress rule up front,
// to the literal host and to every address it resolves to. No operator LAN
// exception is plumbed into this service, so private targets fail closed.
// Git re-resolves the name itself, so this narrows rather than eliminates
// DNS-rebinding; redirects are already disabled in the hardened git config.
export async function assertGitSourceHostIsPublic(
  sourceRef: string,
  lookup: HostAddressLookup = lookUpHostAddresses,
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
  try {
    await assertHostResolvesPublic(parsed, lookup);
  } catch (error) {
    throw inGitWords(error);
  }
}

/**
 * What the Git check always answered: a refused host as the network guard's own error, and a failed lookup in the Git
 * source's own words with the resolver's error as the cause. Anything else passes as it is.
 */
function inGitWords(error: unknown): unknown {
  if (error instanceof HostNotPublicError) return error.cause;
  if (!(error instanceof HostLookupError)) return error;
  if (error.kind === "no_address") return new Error("Git source host did not resolve to any address.");
  return new Error(`Git source host could not be resolved: ${(error.cause as Error).message}`, { cause: error.cause });
}

// ---------------------------------------------------------------------------
// The tree: bounded reads from Git objects, never a checkout
// ---------------------------------------------------------------------------

/**
 * Writes a tree's files from Git objects with three commands whatever its size: the listing, every blob's size in one
 * `cat-file --batch-check`, and, once every size is within the limits, every blob's content in one `cat-file --batch`.
 * Nothing is written until every file has been read in full.
 */
export async function materializeBoundedGitTree(
  repoDir: string,
  signal: AbortSignal,
  options: BoundedGitTreeOptions,
  destDir: string = repoDir,
): Promise<void> {
  const listing = await runBoundedGit(repoDir, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    signal,
    encoding: "utf8",
    maxBuffer: GIT_TREE_OUTPUT_MAX_BYTES,
  });
  const listed = parseBoundedGitTree(String(listing.stdout ?? ""), options);
  if (listed.length === 0) return;
  const run = createGitBatchRunner({
    cwd: repoDir,
    configArgs: hardenedGitConfigArgs(),
    env: buildSanitizedGitEnvironment(),
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  const rules = {
    maxFileBytes: options.limits.maxFileBytes,
    maxTotalBytes: options.limits.maxTotalBytes,
    limitError: options.limitError,
    failedError: GitFetchFailedError,
    words: treeWording(options),
  };
  const files = await readBoundedBlobSizes(run, signal, listed, rules);
  const contents = await readBoundedBlobContents(run, signal, files, rules);
  for (const [index, file] of files.entries()) {
    const destination = path.resolve(destDir, ...file.relativePath.split("/"));
    assertWritePathInJail(destination, [destDir]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents[index]!, { flag: "wx" });
  }
}

export function parseBoundedGitTree(output: string, options: BoundedGitTreeOptions): MaterializedGitTreeFile[] {
  const { limits, limitError } = options;
  const words = treeWording(options);
  const records = output ? output.split("\0") : [];
  if (records.at(-1) === "") records.pop();
  if (records.length > limits.maxFiles) {
    throw new limitError(words.tooManyFiles(limits.maxFiles));
  }
  const files: MaterializedGitTreeFile[] = [];
  const admitPath = createTreePathTracker(words.treeName, limits.maxEntries, limitError);
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator <= 0) throw new GitFetchFailedError(words.listingUnreadable);
    const metadata = record.slice(0, separator).split(" ");
    const relativePath = record.slice(separator + 1);
    const [mode, objectType, objectId] = metadata;
    if (mode !== "100644" || objectType !== "blob" || !/^[a-f0-9]{40}$/u.test(objectId ?? "")) {
      throw new GitTreeRefusedError(words.unsupportedObject(relativePath));
    }
    if (!isPortableTreePath(relativePath)) throw new GitTreeRefusedError(words.notPortable(relativePath));
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

/**
 * Whether a relative path with `/` separators can be written the same on every disk GoatCitadel runs on. This is the
 * contracts' own rule, `isPortablePluginPath`, which a plugin manifest's piece paths are held to as well, so the
 * preflight, a fetched tree and the snapshot store all refuse the same paths.
 */
export const isPortableTreePath: (relativePath: string) => boolean = isPortablePluginPath;

export async function assertBoundedGitMetadata(
  repoDir: string,
  limitError: GitLimitErrorClass,
  wording: GitMetadataWording = PARTIAL_CLONE_METADATA_WORDING,
): Promise<void> {
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
        throw new limitError(wording.metadataTooManyEntries(GIT_METADATA_MAX_ENTRIES));
      }
      const childPath = path.join(current, child.name);
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) throw new GitFetchFailedError(wording.metadataLink);
      if (stat.isDirectory()) {
        queue.push(childPath);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes) || bytes > GIT_METADATA_MAX_BYTES) {
          throw new limitError(wording.metadataTooManyBytes(GIT_METADATA_MAX_BYTES));
        }
      } else {
        throw new GitFetchFailedError(wording.metadataUnsupportedEntry);
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
  admitUrl: (rawUrl) => admitGitSourceUrl(rawUrl, lookUpHostAddresses),
};

/**
 * A plain https address with no user name or token, whose host is public: the literal, and every address a name
 * resolves to. A private or reserved host is a `GitHostRefusedError` (with the network guard's refusal as its cause), and
 * a name that doesn't resolve is a `GitHostLookupError`, so a lookup that failed is never called a private host.
 */
async function admitGitSourceUrl(rawUrl: string, lookup: HostAddressLookup): Promise<string> {
  const safeUrl = safeGitArgument(rawUrl, "Git source address");
  let parsed: URL;
  try {
    parsed = new URL(safeUrl);
  } catch {
    throw new GitFetchInputError(GIT_INPUT_MESSAGES.notHttps);
  }
  if (parsed.protocol !== "https:") throw new GitFetchInputError(GIT_INPUT_MESSAGES.notHttps);
  if (parsed.username || parsed.password) throw new GitFetchInputError(GIT_INPUT_MESSAGES.credentials);
  try {
    await assertHostResolvesPublic(parsed, lookup);
  } catch (error) {
    if (error instanceof HostLookupError) throw new GitHostLookupError({ cause: error });
    throw new GitHostRefusedError({ cause: error instanceof HostNotPublicError ? error.cause : error });
  }
  // Git gets the address as parsed here, not the text it came in as, so both read it the same way.
  return parsed.href;
}

// Test-only route to the production address check with a stand-in resolver, so a lookup that fails can be shown
// without the network.
export function __admitGitSourceUrlForTests(rawUrl: string, lookup: HostAddressLookup): Promise<string> {
  return admitGitSourceUrl(rawUrl, lookup);
}

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
  const options: BoundedGitTreeOptions = {
    limits,
    label: "plugin",
    limitError: GitTreeLimitError,
    wording: PLUGIN_GIT_TREE_WORDING,
  };
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
    await assertBoundedGitMetadata(repoDir, GitTreeLimitError, PLUGIN_GIT_TREE_WORDING);
    await materializeBoundedGitTree(repoDir, deadline.signal, options, destDir);
    const commit = await resolveGitHeadRevision(repoDir);
    if (!/^[a-f0-9]{40}$/u.test(commit ?? "") || (target.kind === "commit" && commit !== target.commit)) {
      throw new GitFetchFailedError(GIT_FETCH_FAILURE_MESSAGES.commitUnconfirmed);
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
    throw new GitFetchFailedError(GIT_FETCH_FAILURE_MESSAGES.otherCommit);
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
    throw new GitFetchInputError(GIT_INPUT_MESSAGES.ref);
  }
  return { kind: "branch", ref: safeGitArgument(trimmed, "Git ref") };
}

function parseFetchLimits(limits: FetchGitTreeInput["limits"]): BoundedGitLimits {
  for (const value of [limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GitFetchInputError(GIT_INPUT_MESSAGES.limits);
    }
  }
  return { ...limits, maxEntries: treeEntryLimit(limits.maxFiles) };
}
