import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord, MemoryItemRecord, NoteRecord } from "@goatcitadel/contracts";
import { loadLibraryResources, resourceDescription, resourceId, type ResourceQuery } from "./library-resources";
import { readLibraryResource, RESOURCE_PREVIEW_BYTES } from "./library-resource-preview";

const api = vi.hoisted(() => ({
  memory: vi.fn(),
  notes: vi.fn(),
  files: vi.fn(),
  artifacts: vi.fn(),
  artifact: vi.fn(),
  file: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchMemoryItems: api.memory }));
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({ listNotes: api.notes }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChatGeneratedArtifacts: api.artifacts,
  fetchChatGeneratedArtifact: api.artifact,
}));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({
  fetchFilesList: api.files,
  downloadFile: api.file,
}));
const query: ResourceQuery = {
  kind: "memory",
  workspaceId: "mine",
  citadelId: "personal",
  query: "",
  status: "active",
};
const memory = (itemId: string, workspaceId?: string): MemoryItemRecord => ({
  itemId,
  title: itemId,
  content: "Memory content",
  namespace: "lessons",
  metadata: {},
  pinned: false,
  status: "active",
  lifecycleState: "active",
  workspaceId,
  createdAt: "2026-09-30",
  updatedAt: "2026-09-30",
});
const note = (noteId: string, workspaceId = "mine"): NoteRecord => ({
  noteId,
  workspaceId,
  title: noteId,
  body: "Note body",
  tags: [],
  sourceRefs: [],
  lifecycleStatus: "active",
  revision: 1,
  createdAt: "2026-09-30",
  updatedAt: "2026-09-30",
});
const artifact = (): ChatGeneratedArtifactRecord => ({
  artifactId: "artifact",
  workspaceId: "mine",
  sessionId: "session",
  turnId: "turn",
  title: "Artifact",
  kind: "markdown",
  content: "# Result",
  contentHash: "a".repeat(64),
  version: 1,
  sourceSurface: "chat",
  createdAt: "2026-09-30",
  updatedAt: "2026-09-30",
});
beforeEach(() => vi.resetAllMocks());

describe("scoped native Library owner reads", () => {
  it("preserves canonical global memory, withholds foreign/conflicting scope, and forwards opaque pagination", async () => {
    api.memory.mockResolvedValue({
      items: [
        memory("owned", "mine"),
        memory("global"),
        memory("foreign", "other"),
        { ...memory("conflict", "mine"), metadata: { workspaceId: "other" } },
        { ...memory("legacy"), metadata: { workspaceId: "mine" } },
      ],
      total: 5,
      nextCursor: "opaque-next",
    });
    const page = await loadLibraryResources({ ...query, cursor: "opaque-current" });
    expect(api.memory).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "mine",
      query: "",
      status: "active",
      limit: 100,
      cursor: "opaque-current",
    });
    expect(page.items.map(resourceId)).toEqual(["owned", "global", "legacy"]);
    expect(page.nextCursor).toBe("opaque-next");
    expect(page.coverage).toContain("inconsistent scope records were withheld");
    expect(resourceDescription(page.items[1]!)).toContain("Global memory");
  });
  it("filters notes by workspace before applying the display bound and preserves lifecycle query", async () => {
    api.notes.mockResolvedValue({
      items: [
        ...Array.from({ length: 110 }, (_, index) => note(`foreign-${index}`, "other")),
        ...Array.from({ length: 105 }, (_, index) => note(`mine-${index}`)),
      ],
    });
    const page = await loadLibraryResources({ ...query, kind: "notes", status: "archived" });
    expect(api.notes).toHaveBeenCalledExactlyOnceWith("mine", { lifecycleStatus: "archived" });
    expect(page.items).toHaveLength(100);
    expect(page.items.every((entry) => resourceId(entry).startsWith("mine-"))).toBe(true);
    expect(page.coverage).toContain("Narrow the filter");
  });
  it("never labels installation files as workspace-owned or sends ignored scope parameters", async () => {
    api.files.mockResolvedValue({ items: [{ relativePath: "notes/test.md", size: 3, modifiedAt: "now" }] });
    const page = await loadLibraryResources({ ...query, kind: "files" });
    expect(api.files).toHaveBeenCalledExactlyOnceWith(".", 100);
    expect(page.coverage).toContain("shared across workspaces");
    expect(resourceDescription(page.items[0]!)).toContain("Installation shared files");
  });
  it("withholds artifacts without exact workspace binding", async () => {
    api.artifacts.mockResolvedValue({
      items: [
        artifact(),
        { ...artifact(), artifactId: "foreign", workspaceId: "other" },
        { ...artifact(), artifactId: "missing", workspaceId: undefined },
      ],
    });
    const page = await loadLibraryResources({ ...query, kind: "artifacts" });
    expect(api.artifacts).toHaveBeenCalledExactlyOnceWith({ workspaceId: "mine", citadelId: "personal", limit: 100 });
    expect(page.items.map(resourceId)).toEqual(["artifact"]);
    expect(page.coverage).toContain("Older records may not be shown");
  });
});

describe("explicit bounded Library previews", () => {
  it.each(["relativePath", "size", "modifiedAt"])("withholds file content when %s changed", async (field) => {
    const item = { relativePath: "notes/test.md", size: 4, modifiedAt: "2026-09-30" };
    api.file.mockResolvedValue({
      ...item,
      [field]: field === "size" ? 5 : "changed",
      encoding: "utf8",
      content: "body",
    });
    await expect(readLibraryResource({ kind: "files", item }, "mine", "personal")).rejects.toThrow(
      "changed after listing",
    );
    expect(api.file).toHaveBeenCalledExactlyOnceWith("notes/test.md");
  });
  it("never downloads a known oversized file and refuses binary content", async () => {
    const item = { relativePath: "large.txt", size: RESOURCE_PREVIEW_BYTES + 1, modifiedAt: "now" };
    await expect(readLibraryResource({ kind: "files", item }, "mine", "personal")).rejects.toThrow("128 KiB");
    expect(api.file).not.toHaveBeenCalled();
    api.file.mockResolvedValue({ ...item, size: 4, encoding: "base64", content: "abcd" });
    await expect(
      readLibraryResource({ kind: "files", item: { ...item, size: 4 } }, "mine", "personal"),
    ).rejects.toThrow("plain text");
  });
  it("uses exact artifact identity and scope, retains redaction truth, and refuses a changed version", async () => {
    const item = artifact();
    api.artifact.mockResolvedValueOnce({ item: { ...item, version: 2 } });
    await expect(readLibraryResource({ kind: "artifacts", item }, "mine", "personal")).rejects.toThrow(
      "changed after listing",
    );
    api.artifact.mockResolvedValue({
      item: { ...item, content: "[redacted]", publicProjection: { contentRedacted: true } },
    });
    const preview = await readLibraryResource({ kind: "artifacts", item }, "mine", "personal");
    expect(api.artifact).toHaveBeenLastCalledWith("artifact", "mine", "personal");
    expect(preview.warning).toContain("Gateway redacted");
  });
  it("bounds owner-supplied note content by UTF-8 bytes", async () => {
    await expect(
      readLibraryResource(
        { kind: "notes", item: { ...note("oversized"), body: "🙂".repeat(RESOURCE_PREVIEW_BYTES / 2) } },
        "mine",
        "personal",
      ),
    ).rejects.toThrow("128 KiB");
  });
});
