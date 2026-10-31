import type { GitTreeWording } from "./hardened-git-wording.js";

// What a plugin's Git fetch says when it refuses a source or a tree, or when the host sends something it can't use.
// These reach the operator as written, so they are plain words, and the cockpit copy guard reads this file. The skill
// import's Git review keeps its own words, in `hardened-git-wording.ts`.

/** The host won't serve a commit by its id. */
export const COMMIT_FETCH_REFUSED_MESSAGE =
  "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag.";

/** The address's host is private, loopback, link-local, metadata or reserved. */
export const HOST_NOT_PUBLIC_MESSAGE = "That address isn't a public host.";

/** The address's host name didn't resolve, or resolved to nothing. */
export const HOST_UNREACHABLE_MESSAGE = "GoatCitadel couldn't reach that host. Check the connection and try again.";

/** What a plugin fetch won't be asked for. */
export const GIT_INPUT_MESSAGES = {
  notHttps: "Git source must be an https URL.",
  credentials: "Git source must not carry a user name or token.",
  ref: "Git ref must be a full commit, or a branch or tag name.",
  limits: "Git tree limits must be positive whole numbers.",
} as const;

/** The host, or Git, answered with something other than what was asked for. */
export const GIT_FETCH_FAILURE_MESSAGES = {
  otherCommit: "The host sent a different commit from the one that was asked for.",
  commitUnconfirmed: "Git couldn't confirm which commit it fetched.",
} as const;

/** How the refusals of a plugin's fetched files read. */
export const PLUGIN_GIT_TREE_WORDING: GitTreeWording = {
  treeName: "The plugin",
  tooManyFiles: (maxFiles) => `A plugin can hold at most ${countOf(maxFiles, "file")}.`,
  unsupportedObject: (relativePath) =>
    `${relativePath} isn't a plain file. A plugin can't hold links, other repositories or files that run.`,
  notPortable: (relativePath) => `${relativePath} has a name that can't be used in a plugin.`,
  listingUnreadable: "Git sent a list of files GoatCitadel couldn't read.",
  fileUnavailable: (relativePath, maxBytes) =>
    `Git didn't send ${relativePath}. One file can be at most ${sizeOf(maxBytes)}.`,
  fileTooLarge: (relativePath, maxBytes) =>
    `${relativePath} is over ${sizeOf(maxBytes)}, which is the most one file can be.`,
  tooManyBytes: (maxBytes) => `A plugin can hold at most ${sizeOf(maxBytes)} in all.`,
  fileChanged: (relativePath) => `Git sent ${relativePath} at a different size from the one it listed.`,
  metadataTooManyEntries: (maxEntries) => `Git's copy of the repository is over ${countOf(maxEntries, "file")}.`,
  metadataTooManyBytes: (maxBytes) => `Git's copy of the repository is over ${sizeOf(maxBytes)}.`,
  metadataLink: "Git's copy of the repository held a link, which GoatCitadel doesn't follow.",
  metadataUnsupportedEntry: "Git's copy of the repository held something other than plain files and folders.",
};

function countOf(amount: number, noun: string): string {
  return `${amount} ${amount === 1 ? noun : `${noun}s`}`;
}

/** A size in MiB, KiB or bytes, whichever reads best. */
function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(2))} MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(2))} KiB`;
  return countOf(bytes, "byte");
}
