import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import { downloadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import type { LibraryResource } from "./library-resources";

export const RESOURCE_PREVIEW_BYTES = 128 * 1024;
export interface ResourcePreview {
  text?: string;
  artifact?: ChatGeneratedArtifactRecord;
  warning?: string;
}
function boundedText(value: string) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > RESOURCE_PREVIEW_BYTES)
    throw new Error(
      "This content exceeds the 128 KiB Library preview limit. Use its management surface to inspect it.",
    );
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
      if (expected.size > RESOURCE_PREVIEW_BYTES)
        throw new Error("This file exceeds the 128 KiB Library preview limit.");
      const file = await downloadFile(expected.relativePath);
      if (
        file.relativePath !== expected.relativePath ||
        file.size !== expected.size ||
        file.modifiedAt !== expected.modifiedAt
      )
        throw new Error("The shared file changed after listing. Refresh the directory before previewing it again.");
      if (file.encoding !== "utf8")
        throw new Error("This file is not a plain text preview. Open file management to download it.");
      return { text: boundedText(file.content), warning: "Plain text from the installation shared file root." };
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
        throw new Error(
          "The artifact has incomplete version, hash, or workspace evidence. Open its management surface to inspect it.",
        );
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
