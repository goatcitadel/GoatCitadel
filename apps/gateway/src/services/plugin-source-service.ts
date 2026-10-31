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
import {
  GitCommitFetchRefusedError,
  GitFetchFailedError,
  GitFetchInputError,
  GitHostLookupError,
  GitHostRefusedError,
  GitTreeLimitError,
  GitTreeRefusedError,
  TEMP_REMOVAL_OPTIONS,
  fetchGitTree,
  isGitProcessFailure,
} from "./hardened-git.js";
import {
  PluginTreeRefusedError,
  listPluginTree,
  readPluginFileBounded,
  type PluginSnapshot,
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

/** What a fetch needs, as plain values and one function, the way `composeCapabilitySkills` takes its owners. */
export interface PluginSourceInputs {
  /** Hashes a temp copy and moves it into place as a snapshot: the snapshot store's `importDirectory`. */
  importSnapshot: (dir: string) => Promise<PluginSnapshot>;
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
  | "HOST_NOT_PUBLIC"
  | "HOST_NOT_FOUND"
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
const GIT_FETCH_FAILED_MESSAGE = "GoatCitadel couldn't fetch that Git repository.";

/**
 * Fetches a plugin source into a snapshot. Throws `PluginSourceError` for anything the source did wrong or the host
 * refused; an error that is GoatCitadel's own (a disk that can't be written) passes through unchanged.
 */
export async function fetchPluginSource(
  source: PluginSource,
  { importSnapshot, builtInRoot, deploymentProfile, tempRoot }: PluginSourceInputs,
): Promise<FetchedPluginSource> {
  try {
    switch (source.kind) {
      case "git":
        return await fetchGitSource(source, importSnapshot, tempRoot);
      case "folder":
        return await fetchFolderSource(source, deploymentProfile, importSnapshot, tempRoot);
      case "built_in":
        return await fetchBuiltInSource(source, builtInRoot, importSnapshot, tempRoot);
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
  importSnapshot: PluginSourceInputs["importSnapshot"],
  tempRoot: string,
): Promise<FetchedPluginSource> {
  const url = admitGitUrl(source.url);
  return withWorkDir(tempRoot, "git-", async (workDir) => {
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
    const snapshot = await importSnapshot(treeDir);
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
    throw invalidGitSource("The address should name a repository, like https://github.com/example/my-plugin.");
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

/**
 * Turns an error from `fetchGitTree` into a `PluginSourceError` when it is one of Git's or hardened-git's own typed
 * refusals, or a Git subprocess failure. Anything else is GoatCitadel's own error (a disk that can't be written, say)
 * and is returned as it is, so it is never labelled a Git failure and its detail stays out of the operator's message.
 */
function asGitFailure(error: unknown): unknown {
  if (error instanceof GitCommitFetchRefusedError) {
    return new PluginSourceError(422, "COMMIT_NOT_FETCHABLE", error.message, { cause: error });
  }
  if (error instanceof GitTreeLimitError) {
    return new PluginSourceError(413, "TREE_OVER_LIMITS", error.message, { cause: error });
  }
  if (error instanceof GitTreeRefusedError) {
    return new PluginSourceError(422, "UNSAFE_TREE", error.message, { cause: error });
  }
  if (error instanceof GitFetchInputError) {
    return new PluginSourceError(400, "INVALID_GIT_SOURCE", error.message, { cause: error });
  }
  if (error instanceof GitHostRefusedError) {
    return new PluginSourceError(422, "HOST_NOT_PUBLIC", error.message, { cause: error });
  }
  // A host name that didn't resolve may be fine once the connection is, so it is never called private.
  if (error instanceof GitHostLookupError) {
    return new PluginSourceError(502, "HOST_NOT_FOUND", error.message, { cause: error });
  }
  // The host or Git sent something other than what was asked for; its fixed sentence says what.
  if (error instanceof GitFetchFailedError) {
    return new PluginSourceError(502, "GIT_FETCH_FAILED", `${GIT_FETCH_FAILED_MESSAGE} ${error.message}`, {
      cause: error,
    });
  }
  if (isGitProcessFailure(error)) {
    return new PluginSourceError(502, "GIT_FETCH_FAILED", `${GIT_FETCH_FAILED_MESSAGE} ${describeGitFailure(error)}`, {
      cause: error,
    });
  }
  return error;
}

/** Text that names a place on this computer (a drive or absolute path) or shows how Git was run. */
const LOCAL_DETAIL = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|[\s'"(=])\/[^\s/]|\bgit\s+-c\b/u;

/**
 * A sentence for why a fetch failed: Git's own last `fatal:` or `error:` line, read from `stderr` (text or a Buffer).
 * It never uses the error's message, which holds the whole command line, and it drops a line that names a path on this
 * computer. The full error stays as the `cause` for the log.
 */
function describeGitFailure(error: unknown): string {
  const failure = error as { name?: string; killed?: boolean; stderr?: unknown };
  if (failure.name === "AbortError" || failure.killed) return "It took too long.";
  const stderr = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString("utf8")
    : typeof failure.stderr === "string"
      ? failure.stderr
      : "";
  const line = stderr
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => /^(?:fatal|error):/iu.test(candidate))
    .at(-1);
  const detail = line?.replace(/^(?:fatal|error):\s*/iu, "").slice(0, 200);
  return detail && !LOCAL_DETAIL.test(detail) ? `Git said: ${detail}` : "Git didn't finish.";
}

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

async function fetchFolderSource(
  source: Extract<PluginSource, { kind: "folder" }>,
  deploymentProfile: DeploymentProfile,
  importSnapshot: PluginSourceInputs["importSnapshot"],
  tempRoot: string,
): Promise<FetchedPluginSource> {
  if (deploymentProfile === "remote_hardened") {
    throw new PluginSourceError(403, "FOLDER_INSTALL_NOT_ALLOWED", FOLDER_REFUSED_MESSAGE);
  }
  const folder = await requireAbsoluteFolder(source.path);
  const snapshot = await copyIntoSnapshot(folder, importSnapshot, tempRoot);
  return {
    snapshot,
    pin: { kind: "content", treeSha256: snapshot.treeSha256 },
    trust: "unverified",
    sourceDisplay: path.basename(folder) || "Folder",
  };
}

/**
 * A Windows network share (`\\server\share`), a `\\?\` or `\\.\` device path, or an NT `\??\` path. Opening one would
 * make this computer contact another, or reach a device, so none of them is a folder on this computer. This reads the
 * text only, and runs before any file system call.
 */
const NETWORK_OR_DEVICE_PATH = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/u;

async function requireAbsoluteFolder(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\u0000")) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "Give the full path of a folder on this computer.");
  }
  if (NETWORK_OR_DEVICE_PATH.test(raw.trimStart())) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "Use a folder on this computer.");
  }
  if (!path.isAbsolute(raw)) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "Give the full path of a folder on this computer.");
  }
  const folder = path.resolve(raw);
  // A folder source is the plugin's own folder; its `.git` folder is version-control metadata, never a plugin. Windows
  // drops a name's trailing dots and spaces, so `.git.` and `.git ` name that same folder.
  if (isGitFolderName(path.basename(folder))) {
    throw new PluginSourceError(400, "INVALID_FOLDER", "Choose the plugin's folder, not its .git folder.");
  }
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

/** Whether a folder's name is `.git` in any case, once the trailing dots and spaces Windows ignores are dropped. */
function isGitFolderName(name: string): boolean {
  return name.replace(/[. ]+$/u, "").toLowerCase() === ".git";
}

// ---------------------------------------------------------------------------
// Built in
// ---------------------------------------------------------------------------

async function fetchBuiltInSource(
  source: Extract<PluginSource, { kind: "built_in" }>,
  builtInRoot: string,
  importSnapshot: PluginSourceInputs["importSnapshot"],
  tempRoot: string,
): Promise<FetchedPluginSource> {
  // The id is checked before any path is built, so no caller text ever reaches the file system.
  if (!isPluginId(source.pluginId)) {
    throw new PluginSourceError(
      400,
      "INVALID_BUILT_IN_ID",
      "That isn't the id of a plugin that ships with GoatCitadel.",
    );
  }
  const folder = path.join(path.resolve(builtInRoot), source.pluginId);
  let info;
  try {
    info = await fs.lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notShipped();
    throw error;
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw notShipped();
  const snapshot = await copyIntoSnapshot(folder, importSnapshot, tempRoot);
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
 * byte is copied, and the store hashes the copy, not the folder: what is hashed is what was kept. Anything named `.git`
 * is left out without being opened, so a snapshot never holds version-control metadata, and a plugin folder that is a
 * checkout gets the same snapshot as the same files without it.
 */
function copyIntoSnapshot(
  sourceRoot: string,
  importSnapshot: PluginSourceInputs["importSnapshot"],
  tempRoot: string,
): Promise<PluginSnapshot> {
  return withWorkDir(tempRoot, "copy-", async (workDir) => {
    const copyDir = path.join(workDir, "tree");
    const files = await listPluginTree(sourceRoot, { skipVcsMetadata: true });
    await fs.mkdir(copyDir);
    for (const file of files) {
      const content = await readPluginFileBounded(file);
      const destination = path.join(copyDir, ...file.relativePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content, { flag: "wx" });
    }
    return importSnapshot(copyDir);
  });
}

/** Runs `work` in a new folder under `tempRoot` and removes the folder afterwards, whatever happened. */
async function withWorkDir<T>(tempRoot: string, prefix: string, work: (workDir: string) => Promise<T>): Promise<T> {
  await fs.mkdir(tempRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(path.resolve(tempRoot), prefix));
  try {
    return await work(workDir);
  } finally {
    // Best effort: the work folder is only scratch, and a failed removal mustn't hide the real result or error.
    await fs.rm(workDir, TEMP_REMOVAL_OPTIONS).catch(() => undefined);
  }
}

function asSourceError(error: unknown): unknown {
  if (error instanceof PluginTreeRefusedError) {
    const statusCode = error.reason === "TREE_OVER_LIMITS" ? 413 : 422;
    return new PluginSourceError(statusCode, error.reason, error.message, { cause: error });
  }
  return error;
}
