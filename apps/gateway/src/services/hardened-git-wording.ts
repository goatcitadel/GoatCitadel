// The words hardened Git's refusals are put in, so each caller keeps its own. The skill import's Git review keeps the
// words it always had (`labelledGitTreeWording`, below); a plugin's fetch speaks plainly (`plugin-git-messages.ts`).

/** The words a refusal of a Git repository's own files is put in. */
export interface GitMetadataWording {
  metadataTooManyEntries(maxEntries: number): string;
  metadataTooManyBytes(maxBytes: number): string;
  metadataLink: string;
  metadataUnsupportedEntry: string;
}

/** The words each refusal of a fetched tree is put in. */
export interface GitTreeWording extends GitMetadataWording {
  /** Opens the collision and entry-limit refusals: "<treeName> contains a case-colliding path: ...". */
  treeName: string;
  tooManyFiles(maxFiles: number): string;
  unsupportedObject(relativePath: string): string;
  notPortable(relativePath: string): string;
  listingUnreadable: string;
  fileUnavailable(relativePath: string, maxBytes: number): string;
  fileTooLarge(relativePath: string, maxBytes: number): string;
  tooManyBytes(maxBytes: number): string;
  fileChanged(relativePath: string): string;
}

/** The words the skill import's Git review has always used for the repository's own files. */
export const PARTIAL_CLONE_METADATA_WORDING: GitMetadataWording = {
  metadataTooManyEntries: (maxEntries) => `Git partial-clone metadata exceeds ${maxEntries} entries.`,
  metadataTooManyBytes: (maxBytes) => `Git partial-clone metadata exceeds ${maxBytes} bytes.`,
  metadataLink: "Git partial-clone metadata contains a symbolic link.",
  metadataUnsupportedEntry: "Git partial-clone metadata contains an unsupported filesystem entry.",
};

/** The words the skill import's Git review has always used, naming the tree by its label: "Git skill tree ...". */
export function labelledGitTreeWording(label: string): GitTreeWording {
  return {
    ...PARTIAL_CLONE_METADATA_WORDING,
    treeName: `Git ${label} tree`,
    tooManyFiles: (maxFiles) => `Git ${label} tree exceeds ${maxFiles} files.`,
    unsupportedObject: (relativePath) =>
      `Git ${label} tree contains a symlink, submodule, or unsupported object at ${relativePath}.`,
    notPortable: (relativePath) => `Git ${label} tree contains a non-portable path: ${relativePath}.`,
    listingUnreadable: `Git ${label} tree returned malformed metadata.`,
    fileUnavailable: (relativePath) =>
      `Git ${label} blob ${relativePath} is unavailable inside the bounded partial clone.`,
    fileTooLarge: (relativePath, maxBytes) => `Git ${label} blob ${relativePath} exceeds ${maxBytes} bytes.`,
    tooManyBytes: (maxBytes) => `Git ${label} tree exceeds ${maxBytes} total bytes.`,
    fileChanged: (relativePath) => `Git ${label} blob ${relativePath} changed during bounded materialization.`,
  };
}
