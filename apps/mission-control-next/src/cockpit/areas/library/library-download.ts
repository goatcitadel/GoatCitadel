import { downloadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import type { FileResource } from "./library-resources";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";

/** Read the owner again; a preview is never download authority. */
export async function readFileDownload(expected: FileResource): Promise<Blob> {
  const file = await downloadFile(expected.relativePath);
  if (file.relativePath !== expected.relativePath || file.size !== expected.size || file.modifiedAt !== expected.modifiedAt) {
    throw new Error("The shared file changed after listing. Refresh the directory before downloading it.");
  }
  if (file.encoding !== "utf8" && file.encoding !== "base64") throw new Error("The Gateway returned an unsupported file encoding.");
  const bytes = file.encoding === "base64" ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)) : new TextEncoder().encode(file.content);
  if (bytes.byteLength !== file.size) throw new Error("The file response is incomplete. Refresh before downloading it.");
  return new Blob([bytes], { type: file.contentType || "application/octet-stream" });
}

export function saveLibraryDownload(filename: string, content: Blob) {
  if (typeof URL.createObjectURL !== "function") throw new Error("Browser downloads are unavailable in this environment.");
  const url = URL.createObjectURL(content);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.split(/[\\/]/u).at(-1) || "download";
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function readArtifactDownload(expected: ChatGeneratedArtifactRecord, workspaceId: string, citadelId: string) {
  if (expected.workspaceId !== workspaceId || !expected.sessionId || !expected.turnId || !expected.contentHash || !Number.isSafeInteger(expected.version) || expected.version < 1) throw new Error("Artifact provenance is incomplete. Download is unavailable.");
  const { item } = await fetchChatGeneratedArtifact(expected.artifactId, workspaceId, citadelId);
  if (!item || ["artifactId", "workspaceId", "sessionId", "turnId", "version", "contentHash", "kind"].some(key => item[key as keyof typeof item] !== expected[key as keyof typeof expected])) throw new Error("Artifact evidence changed. Refresh before downloading.");
  if (item.publicProjection?.contentRedacted || item.publicProjection?.artifactRedacted) throw new Error("The Gateway redacted this artifact. Canonical content is not available for download.");
  const bytes = new TextEncoder().encode(item.content);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== item.contentHash) throw new Error("Artifact content does not match its recorded hash. Download withheld.");
  const extension = item.kind === "markdown" ? "md" : item.kind === "html" ? "html" : item.kind === "mermaid" ? "mmd" : "txt";
  // eslint-disable-next-line no-control-regex -- download filenames must strip control bytes, which are invalid in OS filenames.
  const title = item.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").trim().slice(0, 120) || "artifact";
  return { filename: `${title}.${extension}`, content: new Blob([bytes], { type: "application/octet-stream" }) };
}
