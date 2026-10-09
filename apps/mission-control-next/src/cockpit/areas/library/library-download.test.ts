import { describe, expect, it, vi } from "vitest";
import { downloadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { readFileDownload } from "./library-download";
import { readArtifactDownload } from "./library-download";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatGeneratedArtifact: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ downloadFile: vi.fn() }));
const expected = { relativePath: "proof.txt", size: 3, modifiedAt: "2026-10-06" };
const response = { ...expected, fullPath: "ignored", contentType: "application/octet-stream", encoding: "base64", content: "AP9B" };
describe("Gateway file download custody", () => {
  it("preserves binary bytes from the canonical file owner", async () => {
    vi.mocked(downloadFile).mockResolvedValue(response);
    const blob = await readFileDownload(expected);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 255, 65]);
    expect(downloadFile).toHaveBeenLastCalledWith("proof.txt");
  });
  it.each([{ relativePath: "other.txt" }, { size: 4 }, { modifiedAt: "new" }])("rejects a changed receipt %s", async (change) => {
    vi.mocked(downloadFile).mockResolvedValue({ ...response, ...change });
    await expect(readFileDownload(expected)).rejects.toThrow("changed after listing");
  });
  it("rejects incomplete content and unsupported encodings", async () => {
    vi.mocked(downloadFile).mockResolvedValue({ ...response, content: "AA==" });
    await expect(readFileDownload(expected)).rejects.toThrow("incomplete");
    vi.mocked(downloadFile).mockResolvedValue({ ...response, encoding: "hex" });
    await expect(readFileDownload(expected)).rejects.toThrow("unsupported");
  });
});

const artifact: ChatGeneratedArtifactRecord = { artifactId: "artifact-a", sessionId: "conversation-a", turnId: "message-a", workspaceId: "one", title: "Evidence", content: "abc", contentHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", kind: "text", sourceSurface: "chat", version: 1, createdAt: "now", updatedAt: "now" };
describe("Immutable artifact downloads", () => {
  it("reads canonical bytes and checks their SHA-256 before download", async () => {
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: artifact });
    const file = await readArtifactDownload(artifact, "one", "personal");
    expect(await file.content.text()).toBe("abc");
    expect(file.filename).toBe("Evidence.txt");
    expect(fetchChatGeneratedArtifact).toHaveBeenLastCalledWith("artifact-a", "one", "personal");
  });
  it.each([{ turnId: "other" }, { workspaceId: "other" }, { version: 2 }])("rejects changed provenance %s", async (change) => {
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, ...change } });
    await expect(readArtifactDownload(artifact, "one", "personal")).rejects.toThrow("evidence changed");
  });
  it("never downloads redacted or hash-mismatched content as the canonical artifact", async () => {
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, content: "redacted", publicProjection: { contentRedacted: true, redactedPaths: [], canonicalContentHashRefersToStoredArtifact: true } } });
    await expect(readArtifactDownload(artifact, "one", "personal")).rejects.toThrow("redacted");
    vi.mocked(fetchChatGeneratedArtifact).mockResolvedValue({ item: { ...artifact, content: "corrupt" } });
    await expect(readArtifactDownload(artifact, "one", "personal")).rejects.toThrow("recorded hash");
  });
});
