import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import { downloadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import type { LibraryResource } from "./library-resources";

export const RESOURCE_PREVIEW_BYTES = 128 * 1024;
/** Raster images preview inline up to this size; larger ones are offered as a download. */
export const IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;
/**
 * Raster images only. They render in an <img> from an object URL, which runs no script. SVG (which can carry
 * script) and PDF (which needs a document viewer) are not previewed inline; they are offered as a download.
 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};
export const PREVIEW_NOT_AVAILABLE = "Preview not available for this file. Download it to open it.";
export interface ResourcePreview {
  text?: string;
  artifact?: ChatGeneratedArtifactRecord;
  /** A raster image to show inline; the viewer owns its object URL. */
  image?: Blob;
  /** Neutral: this content has no inline preview, but nothing is wrong with it. */
  unavailable?: string;
  warning?: string;
}
function imageType(relativePath: string) {
  return IMAGE_EXTENSIONS[relativePath.split(".").at(-1)?.toLowerCase() ?? ""];
}
function boundedText(value: string) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > RESOURCE_PREVIEW_BYTES)
    throw new Error("This content is larger than the 128 KiB Library preview limit, so it is not shown here.");
  return value;
}
function artifactIdentity(item: ChatGeneratedArtifactRecord) {
  return JSON.stringify([
    item.artifactId,
    item.workspaceId,
    item.sessionId,
    item.turnId,
    item.version,
    item.contentHash,
    item.kind,
  ]);
}
export async function readLibraryResource(
  resource: LibraryResource,
  workspaceId: string,
  citadelId: string,
): Promise<ResourcePreview> {
  switch (resource.kind) {
    case "memory":
      return {
        text: boundedText(resource.item.content),
        warning: "Memory from the loaded directory snapshot. Refresh the directory for the latest saved content.",
      };
    case "notes":
      return {
        text: boundedText(resource.item.body),
        warning: "Note from the loaded directory snapshot. Refresh the directory for the latest saved content.",
      };
    case "files": {
      const expected = resource.item;
      const image = imageType(expected.relativePath);
      if (expected.size > (image ? IMAGE_PREVIEW_BYTES : RESOURCE_PREVIEW_BYTES))
        return { unavailable: `${PREVIEW_NOT_AVAILABLE} It is larger than the inline preview limit.` };
      const file = await downloadFile(expected.relativePath);
      if (
        file.relativePath !== expected.relativePath ||
        file.size !== expected.size ||
        file.modifiedAt !== expected.modifiedAt
      )
        throw new Error("The shared file changed after listing. Refresh the directory before previewing it again.");
      if (file.encoding === "base64" && INLINE_IMAGE_TYPES.has(file.contentType)) {
        const bytes = Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0));
        if (bytes.byteLength !== file.size)
          throw new Error("The file response is incomplete. Refresh the directory before previewing it again.");
        return { image: new Blob([bytes], { type: file.contentType }) };
      }
      if (file.encoding !== "utf8" || new TextEncoder().encode(file.content).byteLength > RESOURCE_PREVIEW_BYTES)
        return { unavailable: PREVIEW_NOT_AVAILABLE };
      return { text: file.content, warning: "Plain text from the installation shared file root." };
    }
    case "artifacts": {
      const expected = resource.item;
      if (
        expected.workspaceId !== workspaceId ||
        !expected.contentHash ||
        !/^[a-f0-9]{64}$/iu.test(expected.contentHash) ||
        !expected.sessionId ||
        !expected.turnId ||
        !Number.isSafeInteger(expected.version) ||
        expected.version < 1
      )
        throw new Error("The artifact's version, hash or workspace is incomplete, so it is not previewed here.");
      const { item } = await fetchChatGeneratedArtifact(expected.artifactId, workspaceId, citadelId);
      if (!item || artifactIdentity(item) !== artifactIdentity(expected))
        throw new Error("The artifact changed after listing. Refresh the directory before previewing it again.");
      boundedText(item.content);
      return {
        artifact: item,
        ...(item.publicProjection?.contentRedacted
          ? { warning: "The Gateway redacted this preview. Its recorded hash identifies the stored artifact." }
          : {}),
      };
    }
  }
}
