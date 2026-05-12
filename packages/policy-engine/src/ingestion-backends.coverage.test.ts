import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestDocumentViaBackend, searchIngestedContext } from "./ingestion-backends.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("ingestion backend coverage", () => {
  it("ingests file sources and chunks long content with overlap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-ingest-file-"));
    tempDirs.push(root);
    const filePath = path.join(root, "notes.md");
    await fs.writeFile(filePath, `${"a".repeat(350)} ${"b".repeat(350)}`, "utf8");
    const storage = createKnowledgeStorage();

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "file",
        source: filePath,
        namespace: "files",
        title: "Local Notes",
        chunking: {
          targetChars: 300,
          overlapChars: 120,
          maxChunks: 3,
        },
      }),
      storage,
      fetchUrl: vi.fn(),
    });

    expect(result.fetchResult).toMatchObject({
      sourceType: "file",
      sourceRef: filePath,
      title: "Local Notes",
      fromCache: false,
    });
    expect(result.chunksSaved).toBe(3);
    expect(result.chunks).toHaveLength(3);
  });

  it("skips stale or mismatched cache entries and normalizes native HTML URL responses", async () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-source-mismatch",
        namespace: "web",
        sourceType: "text",
        sourceRef: "https://example.com/page",
        title: "Wrong Source",
        metadata: { ingestion: { backend: "native" } },
      },
      {
        docId: "doc-backend-mismatch",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/page",
        title: "Wrong Backend",
        metadata: { ingestion: { backend: "firecrawl" } },
      },
      {
        docId: "doc-expired",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/page",
        title: "Expired",
        metadata: {
          ingestion: {
            backend: "native",
            cacheExpiresAt: "2000-01-01T00:00:00.000Z",
          },
        },
      },
    ]);
    const fetchUrl = vi.fn(async () => ({
      finalUrl: "https://example.com/final",
      statusCode: 200,
      contentType: "text/html",
      body: "<html><head><style>.x{}</style><script>bad()</script></head><body>Hello <b>world</b></body></html>",
    }));

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/page",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
    });

    expect(fetchUrl).toHaveBeenCalledWith("https://example.com/page");
    expect(result.cached).toBe(false);
    expect(result.fetchResult).toMatchObject({
      sourceType: "url",
      sourceRef: "https://example.com/final",
      contentType: "text/html",
      statusCode: 200,
    });
    expect(result.document.text).toBe("Hello world");
  });

  it("search skips orphaned chunks and non-matching text", () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-1",
        namespace: "research",
        sourceType: "text",
        sourceRef: "manual",
        title: "Manual",
        metadata: {
          ingestion: {
            backend: "native",
            fetchedAt: "2026-03-22T12:00:00.000Z",
            trustLevel: "trusted_workspace",
          },
        },
      },
    ]);
    storage.knowledge.appendChunks("missing-doc", [{ content: "needle in orphan", embedding: [] }]);
    storage.knowledge.appendChunks("doc-1", [{ content: "plain unrelated text", embedding: [] }]);

    const result = searchIngestedContext({
      storage,
      query: "needle",
    });

    expect(result).toEqual({
      namespace: "all",
      query: "needle",
      items: [],
    });

    expect(searchIngestedContext({ storage, namespace: "research", query: "   " })).toEqual({
      namespace: "research",
      query: "   ",
      items: [],
    });
  });

  it("requires namespace and permits whitespace-only text documents with no chunks", async () => {
    const storage = createKnowledgeStorage();

    await expect(
      ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "text",
          source: "text",
          namespace: undefined,
        }),
        storage,
        fetchUrl: vi.fn(),
      }),
    ).rejects.toThrow(/namespace is required/i);

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://empty.example",
        namespace: "scratch",
      }),
      storage,
      fetchUrl: vi.fn(async () => ({
        finalUrl: "https://empty.example",
        statusCode: 200,
        contentType: "text/plain",
        body: "   ",
      })),
    });

    expect(result.document.text).toBe("");
    expect(result.chunksSaved).toBe(0);
  });
});

function createRequest(args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName: "docs.ingest",
    args,
    agentId: "agent-1",
    sessionId: "session-1",
    trustLevel: "trusted_workspace",
  } as ToolInvokeRequest;
}

function createKnowledgeStorage(seedDocuments: Array<Record<string, unknown>> = []): Storage {
  const documents = [...seedDocuments];
  const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
  let documentSeq = documents.length;
  let chunkSeq = 0;

  return {
    knowledge: {
      listDocuments: vi.fn((namespace?: string) =>
        documents.filter((doc) => !namespace || doc.namespace === namespace),
      ),
      createDocument: vi.fn((input: Record<string, unknown>) => {
        const doc = {
          docId: `doc-${++documentSeq}`,
          namespace: input.namespace,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          title: input.title,
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString(),
        };
        documents.unshift(doc);
        return doc;
      }),
      appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
        const saved = entries.map((entry, index) => ({
          chunkId: `chunk-${++chunkSeq}`,
          docId,
          seq: index,
          content: entry.content,
          embedding: entry.embedding,
          tokenEstimate: 1,
          createdAt: new Date().toISOString(),
        }));
        chunksByDocId.set(docId, [...(chunksByDocId.get(docId) ?? []), ...saved]);
        return saved;
      }),
      listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
      listChunksByNamespace: vi.fn((namespace?: string) => {
        if (!namespace) {
          return Array.from(chunksByDocId.values()).flat();
        }
        const matchingDocIds = documents
          .filter((doc) => !namespace || doc.namespace === namespace)
          .map((doc) => String(doc.docId));
        return matchingDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
      }),
    },
  } as unknown as Storage;
}
