import type { LibraryResource } from "./library-resources";

const TITLE_LIMIT = 300;

const clip = (value: string) => (value.length > TITLE_LIMIT ? `${value.slice(0, TITLE_LIMIT - 1)}…` : value);
const pathParts = (relativePath: string) => relativePath.split(/[\\/]+/u).filter(Boolean);

/** A file is named by its filename; the folder it sits in is shown separately as muted text. */
export function resourceTitle(resource: LibraryResource) {
  if (resource.kind !== "files") return clip(resource.item.title);
  return clip(pathParts(resource.item.relativePath).at(-1) ?? resource.item.relativePath);
}

/** The folder of a shared file ("notes/drafts"), or undefined at the file root and for other kinds. */
export function resourceFolder(resource: LibraryResource): string | undefined {
  if (resource.kind !== "files") return undefined;
  const folder = pathParts(resource.item.relativePath).slice(0, -1).join("/");
  return folder ? clip(folder) : undefined;
}
