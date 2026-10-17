import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord, MemoryItemRecord, NoteRecord } from "@goatcitadel/contracts";
import {
  loadLibraryResources,
  resourceDescription,
  resourceId,
  resourceTitle as publicResourceTitle,
  type LibraryResource,
  type ResourceQuery,
} from "./library-resources";
import { resourceTitle } from "./resource-title";
import { readLibraryResource, RESOURCE_PREVIEW_BYTES } from "./library-resource-preview";

const api = vi.hoisted(() => ({
  memory: vi.fn(),
  notes: vi.fn(),
  files: vi.fn(),
  artifacts: vi.fn(),
  artifact: vi.fn(),
  file: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({
  fetchMemoryItems: api.memory,
}));
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({
  listNotes: api.notes,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChatGeneratedArtifacts: api.artifacts,
  fetchChatGeneratedArtifact: api.artifact,
}));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({
  fetchFilesPage: api.files,
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

it("forwards project artifact scope and withholds records from another project", async () => {
  api.artifacts.mockResolvedValue({
    items: [
      { ...artifact(), projectId: "mine-project" },
      { ...artifact(), artifactId: "foreign", projectId: "other-project" },
    ],
  });
  const page = await loadLibraryResources({
    ...query,
    kind: "artifacts",
    projectId: "mine-project",
  });
  expect(api.artifacts).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "mine", projectId: "mine-project" }),
  );
  expect(page.items).toHaveLength(1);
  expect(resourceId(page.items[0]!)).toContain("artifact");
});

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
    const page = await loadLibraryResources({
      ...query,
      cursor: "opaque-current",
    });
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
    expect(resourceDescription(page.items[1]!)).toContain("Shared across workspaces");
  });
  it("filters notes by workspace before applying the display bound and preserves lifecycle query", async () => {
    api.notes.mockResolvedValue({
      items: [
        ...Array.from({ length: 110 }, (_, index) => note(`foreign-${index}`, "other")),
        ...Array.from({ length: 105 }, (_, index) => note(`mine-${index}`)),
      ],
    });
    const page = await loadLibraryResources({
      ...query,
      kind: "notes",
      status: "archived",
    });
    expect(api.notes).toHaveBeenCalledExactlyOnceWith("mine", {
      lifecycleStatus: "archived",
    });
    expect(page.items).toHaveLength(100);
    expect(page.items.every((entry) => resourceId(entry).startsWith("mine-"))).toBe(true);
    expect(page.coverage).toContain("Narrow the filter");
  });
  it("never labels installation files as workspace-owned or sends ignored scope parameters", async () => {
    api.files.mockResolvedValue({
      items: [{ relativePath: "notes/test.md", size: 3, modifiedAt: "now" }],
      folders: ["notes"],
      complete: true,
    });
    const page = await loadLibraryResources({ ...query, kind: "files" });
    expect(api.files).toHaveBeenCalledExactlyOnceWith({ dir: ".", limit: 100, query: "" });
    expect(page.coverage).toContain("shared across workspaces");
    expect(resourceDescription(page.items[0]!)).toBe("In notes · 3 B · Installation shared files");
    expect(resourceTitle(page.items[0]!)).toBe("test.md");
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
    expect(api.artifacts).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "mine",
      citadelId: "personal",
      limit: 100,
    });
    expect(page.items.map(resourceId)).toEqual(["artifact"]);
    expect(page.coverage).toContain("Records without this workspace binding were withheld");
  });
});

describe("explicit bounded Library previews", () => {
  it.each(["relativePath", "size", "modifiedAt"])("withholds file content when %s changed", async (field) => {
    const item = {
      relativePath: "notes/test.md",
      size: 4,
      modifiedAt: "2026-09-30",
    };
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
  it("never downloads a known oversized file and offers binary content as a download, not an error (LB-10)", async () => {
    const item = {
      relativePath: "large.txt",
      size: RESOURCE_PREVIEW_BYTES + 1,
      modifiedAt: "now",
    };
    await expect(readLibraryResource({ kind: "files", item }, "mine", "personal")).resolves.toEqual({
      unavailable: expect.stringContaining("Preview not available"),
    });
    expect(api.file).not.toHaveBeenCalled();
    api.file.mockResolvedValue({
      ...item,
      size: 4,
      encoding: "base64",
      content: "abcd",
    });
    await expect(
      readLibraryResource({ kind: "files", item: { ...item, size: 4 } }, "mine", "personal"),
    ).resolves.toEqual({ unavailable: expect.stringContaining("Download it") });
  });
  it("uses exact artifact identity and scope, retains redaction truth, and refuses a changed version", async () => {
    const item = artifact();
    api.artifact.mockResolvedValueOnce({ item: { ...item, version: 2 } });
    await expect(readLibraryResource({ kind: "artifacts", item }, "mine", "personal")).rejects.toThrow(
      "changed after listing",
    );
    api.artifact.mockResolvedValue({
      item: {
        ...item,
        content: "[redacted]",
        publicProjection: { contentRedacted: true },
      },
    });
    const preview = await readLibraryResource({ kind: "artifacts", item }, "mine", "personal");
    expect(api.artifact).toHaveBeenLastCalledWith("artifact", "mine", "personal");
    expect(preview.warning).toContain("Gateway redacted");
  });
  it("bounds owner-supplied note content by UTF-8 bytes", async () => {
    await expect(
      readLibraryResource(
        {
          kind: "notes",
          item: {
            ...note("oversized"),
            body: "🙂".repeat(RESOURCE_PREVIEW_BYTES / 2),
          },
        },
        "mine",
        "personal",
      ),
    ).rejects.toThrow("128 KiB");
  });
});

it("preserves the existing public resourceTitle binding as the pure leaf used by the palette", () => {
  expect(publicResourceTitle).toBe(resourceTitle);
});
it.each(["memory", "notes", "files", "artifacts"] as const)(
  "bounds the %s title at 300 characters with an ellipsis without a resource read",
  (kind) => {
    const value = "界".repeat(301);
    const resource: LibraryResource =
      kind === "files"
        ? {
            kind,
            item: { relativePath: `folder/${value}`, size: 0, modifiedAt: "2026-10-13" },
          }
        : kind === "memory"
          ? { kind, item: { ...memory("m"), title: value } }
          : kind === "notes"
            ? { kind, item: { ...note("n"), title: value } }
            : { kind, item: { ...artifact(), title: value } };
    expect(resourceTitle(resource)).toBe(`${value.slice(0, 299)}…`);
    expect(publicResourceTitle(resource)).toBe(resourceTitle(resource));
    expect(Object.values(api).every((call) => call.mock.calls.length === 0)).toBe(true);
  },
);

it("preserves historical source filtering without normalizing records through another conversation surface", async () => {
  api.artifacts.mockResolvedValue({
    items: [
      { ...artifact(), artifactId: "chat", sourceSurface: "chat" },
      { ...artifact(), artifactId: "plan", sourceSurface: "cowork" },
      { ...artifact(), artifactId: "code", sourceSurface: "code" },
      {
        ...artifact(),
        artifactId: "foreign",
        sourceSurface: "code",
        workspaceId: "other",
      },
    ],
  });
  const page = await loadLibraryResources({
    ...query,
    kind: "artifacts",
    sourceSurface: "code",
  });
  expect(page.items.map(resourceId)).toEqual(["code"]);
  expect(api.artifacts).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "mine",
    citadelId: "personal",
    limit: 100,
  });
  expect(page.coverage).toContain("cover the 4 most recent artifacts loaded");
  expect(page.coverage).toContain("There are no older artifacts");
});
it.each(["session", "turn", "project", "hash"] as const)(
  "finds artifact %s provenance within the scoped returned window",
  async (field) => {
    const item = {
      ...artifact(),
      projectId: "project-specific",
      contentHash: "a".repeat(64),
    };
    api.artifacts.mockResolvedValue({
      items: [item, { ...item, artifactId: "foreign", workspaceId: "other" }],
    });
    const value = {
      session: "session",
      turn: "turn",
      project: "project-specific",
      hash: "a".repeat(64),
    }[field]!;
    const page = await loadLibraryResources({
      ...query,
      kind: "artifacts",
      query: value,
    });
    expect(page.items.map(resourceId)).toEqual(["artifact"]);
  },
);

describe("paged shared files and artifact windows (LB-08)", () => {
  it("lists a folder through the Gateway search and keeps paths relative to the shared root", async () => {
    api.files.mockResolvedValue({
      items: [{ relativePath: "deep/readme.md", size: 3, modifiedAt: "now" }],
      folders: ["deep"],
      nextCursor: "50",
      complete: false,
    });
    const page = await loadLibraryResources({ ...query, kind: "files", dir: "docs", limit: 50, query: "read" });
    expect(api.files).toHaveBeenCalledExactlyOnceWith({ dir: "docs", limit: 50, query: "read" });
    expect(resourceId(page.items[0]!)).toBe("docs/deep/readme.md");
    expect(page).toMatchObject({ folders: ["deep"], hasMore: true });
    expect(page.coverage).toContain("1 newest matching files in docs and its subfolders");
    expect(page.coverage).toContain("some files may be missing");
  });
  it("grows the artifact window for Load more and says when the owner's maximum is reached", async () => {
    api.artifacts.mockResolvedValue({
      items: Array.from({ length: 200 }, (_, index) => ({ ...artifact(), artifactId: `a${index}` })),
    });
    const page = await loadLibraryResources({ ...query, kind: "artifacts", limit: 200 });
    expect(api.artifacts).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    expect(page.hasMore).toBe(true);
    expect(page.coverage).toContain("load more to include them");
    api.artifacts.mockResolvedValue({
      items: Array.from({ length: 1000 }, (_, index) => ({ ...artifact(), artifactId: `b${index}` })),
    });
    const capped = await loadLibraryResources({ ...query, kind: "artifacts", limit: 5000 });
    expect(api.artifacts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1000 }));
    expect(capped.hasMore).toBe(false);
    expect(capped.coverage).toContain("older ones are not shown");
  });
  it("forwards a memory namespace to the Gateway only when one is chosen (LB-12)", async () => {
    api.memory.mockResolvedValue({ items: [], total: 0 });
    await loadLibraryResources({ ...query, namespace: "facts" });
    expect(api.memory).toHaveBeenLastCalledWith(expect.objectContaining({ namespace: "facts" }));
    await loadLibraryResources(query);
    expect(api.memory.mock.lastCall?.[0]).not.toHaveProperty("namespace");
  });
});

describe("inline image previews (LB-10)", () => {
  it("previews a raster image inline and never inlines SVG", async () => {
    const item = { relativePath: "pics/logo.png", size: 3, modifiedAt: "now" };
    api.file.mockResolvedValue({ ...item, contentType: "image/png", encoding: "base64", content: btoa("abc") });
    const preview = await readLibraryResource({ kind: "files", item }, "mine", "personal");
    expect(preview.image).toBeInstanceOf(Blob);
    expect(preview.image?.type).toBe("image/png");
    const svg = { relativePath: "pics/logo.svg", size: 3, modifiedAt: "now" };
    api.file.mockResolvedValue({ ...svg, contentType: "image/svg+xml", encoding: "base64", content: btoa("abc") });
    await expect(readLibraryResource({ kind: "files", item: svg }, "mine", "personal")).resolves.toEqual({
      unavailable: expect.stringContaining("Preview not available"),
    });
  });
});
