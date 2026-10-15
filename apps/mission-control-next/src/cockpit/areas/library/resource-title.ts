import type { LibraryResource } from "./library-resources";

export function resourceTitle(resource: LibraryResource) {
  return (resource.kind === "files" ? resource.item.relativePath : resource.item.title).slice(0, 300);
}
