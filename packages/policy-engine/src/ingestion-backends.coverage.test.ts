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

  it("uses firecrawl defaults, env overrides, and payload content fallbacks", async () => {
    const priorBaseUrl = process.env.FIRECRAWL_BASE_URL;
    const priorApiKey = process.env.FIRECRAWL_API_KEY;
    const priorFetch = globalThis.fetch;
    process.env.FIRECRAWL_BASE_URL = "https://firecrawl.example/";
    process.env.FIRECRAWL_API_KEY = "firecrawl-key";
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              content: "## Firecrawl content",
              metadata: {},
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "url",
          source: "https://example.com/firecrawl",
          namespace: "web",
          backend: "firecrawl",
          title: "Provided Title",
        }),
        storage,
        fetchUrl: vi.fn(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://firecrawl.example/v2/scrape",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer firecrawl-key",
          }),
        }),
      );
      expect(result.fetchResult).toMatchObject({
        rawText: "## Firecrawl content",
        title: "Provided Title",
        contentType: "text/markdown",
      });
    } finally {
      if (priorBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorBaseUrl;
      }
      if (priorApiKey === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = priorApiKey;
      }
      globalThis.fetch = priorFetch;
    }
  });

  it("covers firecrawl request defaults and html-only response fallback", async () => {
    const priorBaseUrl = process.env.FIRECRAWL_BASE_URL;
    const priorApiKey = process.env.FIRECRAWL_API_KEY;
    const priorFetch = globalThis.fetch;
    delete process.env.FIRECRAWL_BASE_URL;
    delete process.env.FIRECRAWL_API_KEY;
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              html: "<main><h1>HTML only</h1></main>",
              title: "Firecrawl Data Title",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "url",
          source: "https://example.com/firecrawl-html",
          namespace: "web",
          backend: "firecrawl",
          firecrawlTimeoutMs: 1_000,
        }),
        storage,
        fetchUrl: vi.fn(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3002/v2/scrape",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(result.fetchResult).toMatchObject({
        rawText: "<main><h1>HTML only</h1></main>",
        title: "Firecrawl Data Title",
        contentType: "text/html",
      });
    } finally {
      if (priorBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorBaseUrl;
      }
      if (priorApiKey === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = priorApiKey;
      }
      globalThis.fetch = priorFetch;
    }
  });

  it("uses firecrawl empty payload and invalid timeout fallbacks", async () => {
    const priorFetch = globalThis.fetch;
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "url",
          source: "https://example.com/firecrawl-empty",
          namespace: "web",
          backend: "firecrawl",
          firecrawlBaseUrl: "https://firecrawl-empty.example",
          firecrawlTimeoutMs: 0,
        }),
        storage,
        fetchUrl: vi.fn(),
      });

      expect(result.fetchResult).toMatchObject({
        rawText: "",
        contentType: "text/html",
      });
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("scores cached native documents with missing ingestion metadata and sparse embeddings", () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-native-default",
        namespace: "research",
        sourceType: "url",
        sourceRef: "https://example.com/default-backend",
        title: "Default Backend",
        metadata: {},
      },
    ]);
    storage.knowledge.appendChunks("doc-native-default", [
      { content: "alpha beta", embedding: [1, undefined, 0.5] as unknown as number[] },
    ]);

    const result = searchIngestedContext({
      storage,
      namespace: "research",
      query: "alpha",
    });

    expect(result.items[0]).toMatchObject({ content: "alpha beta" });
  });

  it("returns cached native documents when ingestion metadata omits backend", async () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-native-default",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/cached",
        title: "Cached Default",
        metadata: {
          ingestion: {
            fetchedAt: "2026-03-22T12:00:00.000Z",
          },
        },
      },
    ]);
    storage.knowledge.appendChunks("doc-native-default", [{ content: "cached text" }]);

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/cached",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl: vi.fn(),
    });

    expect(result.cached).toBe(true);
    expect(result.document.text).toBe("cached text");
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
