import fs from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_LIMITS,
  isTrustedGitForgeUrl,
  namesGitRepository,
  pluginManifestSchema,
  type DeploymentProfile,
  type PluginPin,
  type PluginSource,
  type PluginTrust,
} from "@goatcitadel/contracts";
import { GitCommitFetchRefusedError, GitFetchInputError, GitTreeLimitError, fetchGitTree } from "./hardened-git.js";
import {
  PluginTreeRefusedError,
  listPluginTree,
  readPluginFileBounded,
  type PluginSnapshot,
  type PluginSnapshotStore,
} from "./plugin-snapshot-store.js";

// Plugin sources: where a plugin can come from, and how it becomes a snapshot.
//
// Every source ends the same way: its files are copied into a temp folder, the store hashes that copy and renames it
// into place, and the answer names the snapshot, what it is pinned to and how far it is trusted. Nothing fetched or
// copied here is run. Git addresses go through `hardened-git.ts` (trusted forges only, no credentials); a folder is
// refused on a remote install and read with `lstat` everywhere; a built-in plugin comes only from the shipped folder.

export interface FetchedPluginSource {
  snapshot: PluginSnapshot;
  pin: PluginPin;
  trust: PluginTrust;
  /** "Ships with GoatCitadel", "<host>/<name>/<repo>" or the folder's name. */
  sourceDisplay: string;
}

export interface FetchPluginSourceDeps {
  store: PluginSnapshotStore;
  /** `<rootDir>/plugins`, the folder of plugins that ship with GoatCitadel. */
  builtInRoot: string;
  deploymentProfile: DeploymentProfile;
  /** Where temp copies are made. It should be on the same volume as the store, since the store renames into place. */
  tempRoot: string;
}

export type PluginSourceRefusalReason =
  | "INVALID_SOURCE"
  | "INVALID_GIT_SOURCE"
  | "UNTRUSTED_GIT_HOST"
  | "COMMIT_NOT_FETCHABLE"
  | "GIT_FETCH_FAILED"
  | "FOLDER_INSTALL_NOT_ALLOWED"
  | "INVALID_FOLDER"
  | "FOLDER_NOT_FOUND"
  | "INVALID_BUILT_IN_ID"
  | "BUILT_IN_NOT_FOUND"
  | "UNSAFE_TREE"
  | "TREE_OVER_LIMITS";

/** A source GoatCitadel refused or couldn't fetch. `statusCode` is the HTTP status that fits, and `message` is plain words. */
export class PluginSourceError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly reason: PluginSourceRefusalReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PluginSourceError";
  }
}

const BUILT_IN_DISPLAY = "Ships with GoatCitadel";
const UNTRUSTED_GIT_HOST_MESSAGE = "GoatCitadel installs plugins only from GitHub, GitLab, Bitbucket or Codeberg.";
const FOLDER_REFUSED_MESSAGE = "Folder installs work only when GoatCitadel runs on this computer.";
const WORK_DIR_REMOVAL = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** What the readers below need, as plain values and one function. Nothing past the entry point reaches into `deps`. */
interface SourceReaders {
  importDirectory: (dir: string) => Promise<PluginSnapshot>;
  builtInRoot: string;
  deploymentProfile: DeploymentProfile;
  tempRoot: string;
}

export type FetchPluginSource = (source: PluginSource, deps: FetchPluginSourceDeps) => Promise<FetchedPluginSource>;

/**
 * Fetches a plugin source into a snapshot. Throws `PluginSourceError` for anything the source did wrong or the host
 * refused; an error that is GoatCitadel's own (a disk that can't be written) passes through unchanged.
 */
export const fetchPluginSource: FetchPluginSource = (source, deps) =>
  fetchFromReaders(source, {
    importDirectory: (dir) => deps.store.importDirectory(dir),
    builtInRoot: deps.builtInRoot,
    deploymentProfile: deps.deploymentProfile,
    tempRoot: deps.tempRoot,
  });

async function fetchFromReaders(source: PluginSource, readers: SourceReaders): Promise<FetchedPluginSource> {
  try {
    switch (source.kind) {
      case "git":
        return await fetchGitSource(source, readers);
      case "folder":
        return await fetchFolderSource(source, readers);
      case "built_in":
        return await fetchBuiltInSource(source, readers);
      default:
        throw new PluginSourceError(400, "INVALID_SOURCE", "That isn't a kind of plugin source GoatCitadel knows.");
    }
  } catch (error) {
    throw asSourceError(error);
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

async function fetchGitSource(
  source: Extract<PluginSource, { kind: "git" }>,
  readers: SourceReaders,
): Promise<FetchedPluginSource> {
  const url = admitGitUrl(source.url);
  return withWorkDir(readers, "git-", async (workDir) => {
    const treeDir = path.join(workDir, "tree");
    let commit: string;
    try {
      ({ commit } = await fetchGitTree({
        url: url.href,
        ref: source.ref,
        destDir: treeDir,
        limits: {
          maxFiles: PLUGIN_LIMITS.maxFiles,
          maxTotalBytes: PLUGIN_LIMITS.maxTotalBytes,
          maxFileBytes: PLUGIN_LIMITS.maxFileBytes,
        },
      }));
    } catch (error) {
      throw asGitFailure(error);
    }
    const snapshot = await readers.importDirectory(treeDir);
    return { snapshot, pin: { kind: "commit", commit }, trust: "unverified", sourceDisplay: describeGitSource(url) };
  });
}

/** The address as a `URL`, once it is a plain https address on a trusted forge that names a repository, with nothing secret in it. */
function admitGitUrl(raw: unknown): URL {
  if (typeof raw !== "string") throw invalidGitSource("Give the address of a Git repository.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidGitSource("That isn't a web address for a Git repository.");
  }
  if (url.protocol !== "https:") throw invalidGitSource("Use an https address.");
  if (url.username || url.password) {
    throw invalidGitSource(
      "Leave the user name and token out of the address. GoatCitadel fetches plugins without signing in.",
    );
  }
  if (url.search || url.hash) throw invalidGitSource("Leave anything after a ? or # out of the address.");
  if (!isTrustedGitForgeUrl(url)) throw new PluginSourceError(400, "UNTRUSTED_GIT_HOST", UNTRUSTED_GIT_HOST_MESSAGE);
  if (!namesGitRepository(url.pathname)) {
    throw invalidGitSource("The address should name a repository, like https://github.com/owner/repo.");
  }
  return url;
}

function invalidGitSource(message: string): PluginSourceError {
  return new PluginSourceError(400, "INVALID_GIT_SOURCE", message);
}

/** `<host>/<owner>/<repo>`, without a trailing `.git` or slash. A host with groups inside groups keeps every group. */
function describeGitSource(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.length - 1;
  const named = segments.map((segment, index) => (index === last ? segment.replace(/\.git$/iu, "") : segment));
  return [url.hostname, ...named].join("/");
}

function asGitFailure(error: unknown): Error {
  if (error instanceof PluginSourceError) return error;
  if (error instanceof GitCommitFetchRefusedError) {
    return new PluginSourceError(422, "COMMIT_NOT_FETCHABLE", error.message, { cause: error });
  }
  if (error instanceof GitTreeLimitError) {
    return new PluginSourceError(413, "TREE_OVER_LIMITS", error.message, { cause: error });
  }
  if (error instanceof GitFetchInputError) {
    return new PluginSourceError(400, "INVALID_GIT_SOURCE", error.message, { cause: error });
  }
  return new PluginSourceError(
    502,
    "GIT_FETCH_FAILED",
    `GoatCitadel couldn't fetch that Git repository. ${describeGitFailure(error)}`,
    { cause: error },
  );
}

/**
 * A sentence for why a fetch failed: Git's own last `fatal:` or `error:` line when it has one. The command line and
 * temp paths that Node puts in the error message are left out; the full error stays as the `cause` for the log.
 */
function describeGitFailure(error: unknown): string {
  const failure = error as { name?: string; killed?: boolean; stderr?: unknown; message?: unknown };
  if (failure.name === "AbortError" || failure.killed) return "It took too long.";
  if (typeof failure.stderr === "string") {
    const line = failure.stderr
      .split(/\r?\n/u)
      .map((candidate) => candidate.trim())
      .filter((candidate) => /^(?:fatal|error):/iu.test(candidate))
      .at(-1);
    return line ? `Git said: ${line.replace(/^(?:fatal|error):\s*/iu, "").slice(0, 200)}` : "Git didn't finish.";
  }
  return typeof failure.message === "string" && failure.message ? failure.message.slice(0, 200) : "Git didn't finish.";
}

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

async function fetchFolderSource(
  source: Extract<PluginSource, { kind: "folder" }>,
  readers: SourceReaders,
): Promise<FetchedPluginSource> {
  if (readers.deploymentProfile === "remote_hardened") {
    throw new PluginSourceError(403, "FOLDER_INSTALL_NOT_ALLOWED", FOLDER_REFUSED_MESSAGE);
  }
  const folder = await requireAbsoluteFolder(source.path);
  const snapshot = await copyIntoSnapshot(folder, readers);
  return {
    snapshot,
    pin: { kind: "content", treeSha256: snapshot.treeSha256 },
    trust: "unverified",
    sourceDisplay: path.basename(folder) || "Folder",
  };
}

async function requireAbsoluteFolder(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\u0000") || !path.isAbsolute(raw)) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "Give the full path of a folder on this computer.");
  }
  const folder = path.resolve(raw);
  let info;
  try {
    info = await fs.lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new PluginSourceError(404, "FOLDER_NOT_FOUND", "There's no folder at that path.");
    }
    throw error;
  }
  // A link is left for the tree check, which refuses it and says why.
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "That path isn't a folder.");
  }
  return folder;
}

// ---------------------------------------------------------------------------
// Built in
// ---------------------------------------------------------------------------

async function fetchBuiltInSource(
  source: Extract<PluginSource, { kind: "built_in" }>,
  readers: SourceReaders,
): Promise<FetchedPluginSource> {
  // The id is checked before any path is built, so no caller text ever reaches the file system.
  if (!isPluginId(source.pluginId)) {
    throw new PluginSourceError(
      400,
      "INVALID_BUILT_IN_ID",
      "That isn't the id of a plugin that ships with GoatCitadel.",
    );
  }
  const folder = path.join(path.resolve(readers.builtInRoot), source.pluginId);
  let info;
  try {
    info = await fs.lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notShipped();
    throw error;
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw notShipped();
  const snapshot = await copyIntoSnapshot(folder, readers);
  return {
    snapshot,
    pin: { kind: "content", treeSha256: snapshot.treeSha256 },
    trust: "built_in",
    sourceDisplay: BUILT_IN_DISPLAY,
  };
}

function notShipped(): PluginSourceError {
  return new PluginSourceError(404, "BUILT_IN_NOT_FOUND", "GoatCitadel doesn't ship a plugin with that id.");
}

/** Whether `value` is a plugin id by the manifest's own rule, which this asks the manifest schema rather than repeating. */
function isPluginId(value: unknown): value is string {
  return typeof value === "string" && pluginManifestSchema.shape.pluginId.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Copies a folder into a temp copy under `tempRoot` and imports that copy. The folder is checked and measured before a
 * byte is copied, and the store hashes the copy, not the folder: what is hashed is what was kept.
 */
function copyIntoSnapshot(sourceRoot: string, readers: SourceReaders): Promise<PluginSnapshot> {
  return withWorkDir(readers, "copy-", async (workDir) => {
    const copyDir = path.join(workDir, "tree");
    const files = await listPluginTree(sourceRoot);
    await fs.mkdir(copyDir);
    for (const file of files) {
      const content = await readPluginFileBounded(file);
      const destination = path.join(copyDir, ...file.relativePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content, { flag: "wx" });
    }
    return readers.importDirectory(copyDir);
  });
}

/** Runs `work` in a new folder under `tempRoot` and removes the folder afterwards, whatever happened. */
async function withWorkDir<T>(
  readers: SourceReaders,
  prefix: string,
  work: (workDir: string) => Promise<T>,
): Promise<T> {
  await fs.mkdir(readers.tempRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(path.resolve(readers.tempRoot), prefix));
  try {
    return await work(workDir);
  } finally {
    await fs.rm(workDir, WORK_DIR_REMOVAL).catch(() => undefined);
  }
}

function asSourceError(error: unknown): unknown {
  if (error instanceof PluginTreeRefusedError) {
    const statusCode = error.reason === "TREE_OVER_LIMITS" ? 413 : 422;
    return new PluginSourceError(statusCode, error.reason, error.message, { cause: error });
  }
  return error;
}
