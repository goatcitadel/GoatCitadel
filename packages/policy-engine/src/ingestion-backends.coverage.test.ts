import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { Document, Packer, Paragraph } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestDocumentViaBackend, searchIngestedContext } from "./ingestion-backends.js";
import { ToolPolicyEngine } from "./engine.js";

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
    expect(result.document.metadata).toMatchObject({
      ingestion: {
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.chunksSaved).toBe(3);
    expect(result.chunks).toHaveLength(3);
  });

  it("parses native PDF, DOCX, XLSX, and CSV file sources before chunking", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-ingest-docs-"));
    tempDirs.push(root);
    const pdfPath = path.join(root, "brief.pdf");
    const docxPath = path.join(root, "brief.docx");
    const xlsxPath = path.join(root, "brief.xlsx");
    const csvPath = path.join(root, "brief.csv");
    await fs.writeFile(pdfPath, createPdfBuffer("PDF parser happy path"));
    await fs.writeFile(
      docxPath,
      await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("DOCX parser happy path")] }],
        }),
      ),
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "status"],
        ["xlsx parser", "happy path"],
      ]),
      "Evidence",
    );
    const workbookBytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await fs.writeFile(xlsxPath, workbookBytes);
    await fs.writeFile(csvPath, "name,status\ncsv parser,happy path\n", "utf8");
    const storage = createKnowledgeStorage();

    const inputs = [
      { path: pdfPath, format: "pdf", expected: "PDF parser happy path", parserId: "unpdf-pdfjs-v1" },
      { path: docxPath, format: "docx", expected: "DOCX parser happy path", parserId: "mammoth-docx-v1" },
      { path: xlsxPath, format: "xlsx", expected: "xlsx parser", parserId: "sheetjs-xlsx-v1" },
      { path: csvPath, format: "csv", expected: "csv parser", parserId: "native-csv-text-v1" },
    ];

    for (const input of inputs) {
      const result = await ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "file",
          source: input.path,
          namespace: "files",
          title: path.basename(input.path),
        }),
        storage,
        fetchUrl: vi.fn(),
      });

      expect(result.document.text).toContain(input.expected);
      expect(result.document.metadata).toMatchObject({
        ingestion: {
          parser: {
            parserId: input.parserId,
            format: input.format,
          },
          rawContentStored: false,
        },
      });
      expect(result.chunksSaved).toBeGreaterThan(0);
      expect(result.chunks[0]?.content).toContain(input.expected);
    }
  }, 20_000);

  it("fails unsupported binary native file formats clearly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-ingest-binary-"));
    tempDirs.push(root);
    const filePath = path.join(root, "image.png");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    await expect(
      ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "file",
          source: filePath,
          namespace: "files",
          title: "Binary",
        }),
        storage: createKnowledgeStorage(),
        fetchUrl: vi.fn(),
      }),
    ).rejects.toThrow(/cannot parse binary file format '.png'/i);
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

  it("search skips orphaned chunks and non-matching text", async () => {
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

    const result = await searchIngestedContext({
      storage,
      query: "needle",
    });

    expect(result).toEqual({
      namespace: "all",
      query: "needle",
      items: [],
    });

    await expect(searchIngestedContext({ storage, namespace: "research", query: "   " })).resolves.toEqual({
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
              metadata: { sourceURL: "https://example.com/firecrawl" },
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
        networkAllowlist: ["firecrawl.example", "example.com"],
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

  it("accepts lowercase Firecrawl sourceUrl metadata as the final source proof", async () => {
    const priorBaseUrl = process.env.FIRECRAWL_BASE_URL;
    const priorFetch = globalThis.fetch;
    process.env.FIRECRAWL_BASE_URL = "https://firecrawl.example/";
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "## Lowercase source proof",
              metadata: { sourceUrl: "https://example.com/lowercase-final" },
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
          source: "https://example.com/lowercase-start",
          namespace: "web",
          backend: "firecrawl",
        }),
        storage,
        networkAllowlist: ["firecrawl.example", "example.com"],
        sourceAllowlist: ["example.com"],
        fetchUrl: vi.fn(),
      });

      expect(result.fetchResult).toMatchObject({
        sourceRef: "https://example.com/lowercase-final",
        rawText: "## Lowercase source proof",
      });
    } finally {
      if (priorBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorBaseUrl;
      }
      globalThis.fetch = priorFetch;
    }
  });

  it("does not read Firecrawl API keys from non-Firecrawl env-name input", async () => {
    const priorBaseUrl = process.env.FIRECRAWL_BASE_URL;
    const priorFirecrawlKey = process.env.FIRECRAWL_API_KEY;
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    const priorConfiguredKeyEnv = process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV;
    const priorFetch = globalThis.fetch;
    process.env.FIRECRAWL_BASE_URL = "https://firecrawl.example/";
    delete process.env.FIRECRAWL_API_KEY;
    process.env.OPENAI_API_KEY = "openai-secret";
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(async (_input, init) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      return new Response(
        JSON.stringify({
          data: {
            markdown: "safe firecrawl response",
            metadata: { sourceURL: "https://example.com/firecrawl" },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await ingestDocumentViaBackend({
        request: createRequest({
          sourceType: "url",
          source: "https://example.com/firecrawl",
          namespace: "web",
          backend: "firecrawl",
          firecrawlApiKeyEnv: "OPENAI_API_KEY",
        }),
        storage,
        networkAllowlist: ["firecrawl.example", "example.com"],
        fetchUrl: vi.fn(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://firecrawl.example/v2/scrape",
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );
    } finally {
      if (priorBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorBaseUrl;
      }
      if (priorFirecrawlKey === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = priorFirecrawlKey;
      }
      if (priorOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAiKey;
      }
      if (priorConfiguredKeyEnv === undefined) {
        delete process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV;
      } else {
        process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV = priorConfiguredKeyEnv;
      }
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects non-canonical loopback Firecrawl ingest base URLs", async () => {
    const priorFetch = globalThis.fetch;
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl",
            namespace: "web",
            backend: "firecrawl",
            firecrawlBaseUrl: "http://127.0.0.1",
          }),
          storage,
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Private|reserved|metadata/i);

      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl",
            namespace: "web",
            backend: "firecrawl",
            firecrawlBaseUrl: "http://localhost:80",
          }),
          storage,
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Private|reserved|metadata/i);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects non-canonical Firecrawl backend labels and non-allowlisted Firecrawl bases", async () => {
    const priorFetch = globalThis.fetch;
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { markdown: "must not fetch" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl",
            namespace: "web",
            backend: " firecrawl ",
            firecrawlBaseUrl: "https://firecrawl.example",
          }),
          storage,
          networkAllowlist: ["firecrawl.example"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/backend must be one of native\|firecrawl/);

      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl",
            namespace: "web",
            backend: "firecrawl",
            firecrawlBaseUrl: "https://firecrawl.example",
          }),
          storage,
          networkAllowlist: ["api.openai.com"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Host is not yet allowlisted/i);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
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
          redirect: "manual",
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
        new Response(JSON.stringify({ data: { metadata: { sourceURL: "https://example.com/firecrawl-empty" } } }), {
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
        networkAllowlist: ["firecrawl-empty.example", "example.com"],
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

  it("rejects non-http Firecrawl source and reported final URLs", async () => {
    const priorFetch = globalThis.fetch;
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "must not be returned",
              metadata: { sourceURL: "file:///etc/passwd" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "file:///etc/passwd",
            namespace: "web",
            backend: "firecrawl",
          }),
          storage,
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/source must use http or https/i);
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl-file-final",
            namespace: "web",
            backend: "firecrawl",
          }),
          storage,
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Firecrawl returned a final URL/i);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects Firecrawl final URLs outside the granted source host boundary", async () => {
    const storage = createKnowledgeStorage();
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "must not be returned",
              metadata: { sourceURL: "https://redirect.example/final" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl-redirect",
            namespace: "web",
            backend: "firecrawl",
          }),
          storage,
          networkAllowlist: ["example.com"],
          sourceAllowlist: ["example.com"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/outside the allowed source boundary/i);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects Firecrawl final URLs outside the runtime network allowlist", async () => {
    const storage = createKnowledgeStorage();
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "must not be returned",
              metadata: { sourceURL: "https://redirect.example/final" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl-redirect",
            namespace: "web",
            backend: "firecrawl",
          }),
          storage,
          networkAllowlist: ["example.com"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/outside the allowed source boundary/i);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects original Firecrawl sources outside runtime or grant boundaries before fetch", async () => {
    const storage = createKnowledgeStorage();
    const priorFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://blocked.example/firecrawl-source",
            namespace: "web",
            backend: "firecrawl",
            firecrawlBaseUrl: "https://firecrawl.example",
          }),
          storage,
          networkAllowlist: ["firecrawl.example", "allowed.example"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Host is not yet allowlisted/i);

      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://allowed.example/firecrawl-source",
            namespace: "web",
            backend: "firecrawl",
            firecrawlBaseUrl: "https://firecrawl.example",
          }),
          storage,
          networkAllowlist: ["firecrawl.example", "allowed.example"],
          sourceAllowlist: ["other.example"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/Host is not yet allowlisted/i);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects Firecrawl content without final source proof when allowlists are active", async () => {
    const storage = createKnowledgeStorage();
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: "must not be returned",
              metadata: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        ingestDocumentViaBackend({
          request: createRequest({
            sourceType: "url",
            source: "https://example.com/firecrawl-missing-final",
            namespace: "web",
            backend: "firecrawl",
          }),
          storage,
          networkAllowlist: ["firecrawl.example", "example.com"],
          sourceAllowlist: ["example.com"],
          fetchUrl: vi.fn(),
        }),
      ).rejects.toThrow(/did not report a final source URL/i);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("scores cached native documents with missing ingestion metadata and sparse embeddings", async () => {
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

    const result = await searchIngestedContext({
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
            parser: {
              parserId: "native-text-v1",
              format: "text",
            },
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
    expect(result.fetchResult.parser).toEqual({
      parserId: "native-text-v1",
      format: "text",
    });
  });

  it("preserves untrusted ingestion source trust through cache, search, and privileged policy checks", async () => {
    const storage = createKnowledgeStorage();
    const fetchUrl = vi.fn(async () => ({
      finalUrl: "https://example.com/untrusted",
      statusCode: 200,
      contentType: "text/plain",
      body: "untrusted instructions",
    }));

    const ingested = await ingestDocumentViaBackend({
      request: {
        ...createRequest({
          sourceType: "url",
          source: "https://example.com/untrusted",
          namespace: "web",
          backend: "native",
        }),
        trustLevel: "untrusted_external",
      },
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
      sourceAllowlist: ["example.com"],
    });
    const cached = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/untrusted",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
      sourceAllowlist: ["example.com"],
    });
    const search = await searchIngestedContext({
      storage,
      namespace: "web",
      query: "untrusted",
    });
    const engine = new ToolPolicyEngine(createPolicyConfig(), createPolicyStorage());
    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      sourceAttribution: search.items[0]?.attribution ? [search.items[0].attribution] : [],
    });

    expect(ingested.document.metadata.ingestion).toMatchObject({
      trustLevel: "untrusted_external",
    });
    expect(cached.cached).toBe(true);
    expect(cached.document.attribution.trustLevel).toBe("untrusted_external");
    expect(cached.chunks[0]?.attribution.trustLevel).toBe("untrusted_external");
    expect(search.items[0]?.attribution.trustLevel).toBe("untrusted_external");
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("preserves external snapshot attribution and rejects stored trust promotion during retrieval", async () => {
    const storedTrustLevels = [
      "trusted_operator",
      "trusted_workspace",
      "mixed_untrusted",
      "untrusted_external",
    ] as const;
    const sourceRefs = storedTrustLevels.map((_, index) => `external-source://snapshot/binding-sha-256-${index + 1}`);
    const storage = createKnowledgeStorage(
      storedTrustLevels.map((trustLevel, index) => ({
        docId: `doc-external-snapshot-${index + 1}`,
        namespace: "workspace/workspace-1/external-source-snapshots",
        sourceType: "external_source_snapshot",
        sourceRef: sourceRefs[index],
        title: `Imported external snapshot ${index + 1}`,
        metadata: {
          ingestion: {
            trustLevel,
          },
        },
      })),
    );
    for (let index = 0; index < storedTrustLevels.length; index += 1) {
      storage.knowledge.appendChunks(`doc-external-snapshot-${index + 1}`, [
        { content: "external snapshot instructions", embedding: [] },
      ]);
    }

    const search = await searchIngestedContext({
      storage,
      namespace: "workspace/workspace-1/external-source-snapshots",
      query: "external snapshot",
    });
    const engine = new ToolPolicyEngine(createPolicyConfig(), createPolicyStorage());
    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      sourceAttribution: search.items.map((item) => item.attribution),
    });

    expect(search.items).toHaveLength(storedTrustLevels.length);
    expect(search.items.map((item) => item.attribution.sourceRef).sort()).toEqual([...sourceRefs].sort());
    expect(
      search.items.every(
        (item) =>
          item.attribution.sourceType === "external_source_snapshot" &&
          item.attribution.trustLevel === "untrusted_external",
      ),
    ).toBe(true);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("defaults URL and text ingestion without explicit trust to untrusted sources", async () => {
    const storage = createKnowledgeStorage();
    const fetchUrl = vi.fn(async () => ({
      finalUrl: "https://example.com/default-untrusted",
      statusCode: 200,
      contentType: "text/plain",
      body: "unsafe external instructions",
    }));

    const urlIngested = await ingestDocumentViaBackend({
      request: createRequestWithoutTrust({
        sourceType: "url",
        source: "https://example.com/default-untrusted",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
      sourceAllowlist: ["example.com"],
    });
    const urlCached = await ingestDocumentViaBackend({
      request: createRequestWithoutTrust({
        sourceType: "url",
        source: "https://example.com/default-untrusted",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
      sourceAllowlist: ["example.com"],
    });
    const textIngested = await ingestDocumentViaBackend({
      request: createRequestWithoutTrust({
        sourceType: "text",
        source: "unsafe pasted instructions",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
    });
    const promotedUrlIngested = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/promoted-trust",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
      sourceAllowlist: ["example.com"],
    });
    const promotedTextIngested = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "text",
        source: "trusted-looking pasted instructions",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
    });
    const search = await searchIngestedContext({
      storage,
      namespace: "web",
      query: "unsafe",
    });
    const engine = new ToolPolicyEngine(createPolicyConfig(), createPolicyStorage());
    const shellEvaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      sourceAttribution: search.items.map((item) => item.attribution),
    });
    const writeEvaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      sourceAttribution: search.items.map((item) => item.attribution),
    });

    expect(urlIngested.document.attribution.trustLevel).toBe("untrusted_external");
    expect(urlCached.cached).toBe(true);
    expect(urlCached.document.attribution.trustLevel).toBe("untrusted_external");
    expect(urlCached.chunks[0]?.attribution.trustLevel).toBe("untrusted_external");
    expect(textIngested.document.attribution.trustLevel).toBe("untrusted_external");
    expect(promotedUrlIngested.document.attribution.trustLevel).toBe("untrusted_external");
    expect(promotedTextIngested.document.attribution.trustLevel).toBe("untrusted_external");
    expect(search.items).toHaveLength(3);
    expect(search.items.every((item) => item.attribution.trustLevel === "untrusted_external")).toBe(true);
    expect(shellEvaluation.allowed).toBe(false);
    expect(writeEvaluation.allowed).toBe(false);
    expect(shellEvaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
    expect(writeEvaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("treats legacy URL and text cache rows without stored trust as untrusted", async () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-legacy-url",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/legacy",
        title: "Legacy URL",
        metadata: {
          ingestion: {
            backend: "native",
            fetchedAt: "2026-03-22T12:00:00.000Z",
          },
        },
      },
      {
        docId: "doc-legacy-text",
        namespace: "web",
        sourceType: "text",
        sourceRef: "legacy text",
        title: "Legacy Text",
        metadata: {
          ingestion: {
            backend: "native",
            fetchedAt: "2026-03-22T12:00:00.000Z",
          },
        },
      },
    ]);
    storage.knowledge.appendChunks("doc-legacy-url", [{ content: "legacy unsafe url instructions" }]);
    storage.knowledge.appendChunks("doc-legacy-text", [{ content: "legacy unsafe text instructions" }]);

    const cached = await ingestDocumentViaBackend({
      request: createRequestWithoutTrust({
        sourceType: "url",
        source: "https://example.com/legacy",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl: vi.fn(),
    });
    const search = await searchIngestedContext({
      storage,
      namespace: "web",
      query: "legacy unsafe",
    });
    const engine = new ToolPolicyEngine(createPolicyConfig(), createPolicyStorage());
    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      sourceAttribution: search.items.map((item) => item.attribution),
    });

    expect(cached.cached).toBe(true);
    expect(cached.document.attribution.trustLevel).toBe("untrusted_external");
    expect(cached.chunks[0]?.attribution.trustLevel).toBe("untrusted_external");
    expect(search.items.map((item) => item.attribution.trustLevel)).toEqual([
      "untrusted_external",
      "untrusted_external",
    ]);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("refetches URL cache entries without final-source proof when a source allowlist is active", async () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-native-unproven",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/cached",
        title: "Cached Without Final URL",
        metadata: {
          ingestion: {
            backend: "native",
            fetchedAt: "2026-03-22T12:00:00.000Z",
            cacheExpiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      },
    ]);
    storage.knowledge.appendChunks("doc-native-unproven", [{ content: "cached must not be returned" }]);
    const fetchUrl = vi.fn(async () => ({
      finalUrl: "https://example.com/fresh",
      statusCode: 200,
      contentType: "text/plain",
      body: "fresh allowed content",
    }));

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/cached",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      sourceAllowlist: ["example.com"],
    });

    expect(fetchUrl).toHaveBeenCalledWith("https://example.com/cached");
    expect(result.cached).toBe(false);
    expect(result.document.text).toBe("fresh allowed content");
    expect(result.document.metadata).toMatchObject({
      ingestion: {
        finalSourceUrl: "https://example.com/fresh",
      },
    });
  });

  it("refetches URL cache entries whose final-source proof is outside the runtime network allowlist", async () => {
    const storage = createKnowledgeStorage([
      {
        docId: "doc-native-network-drift",
        namespace: "web",
        sourceType: "url",
        sourceRef: "https://example.com/cached",
        title: "Cached Redirected URL",
        metadata: {
          ingestion: {
            backend: "native",
            fetchedAt: "2026-03-22T12:00:00.000Z",
            cacheExpiresAt: "2099-01-01T00:00:00.000Z",
            finalSourceUrl: "https://redirect.example/final",
          },
        },
      },
    ]);
    storage.knowledge.appendChunks("doc-native-network-drift", [{ content: "cached must not be returned" }]);
    const fetchUrl = vi.fn(async () => ({
      finalUrl: "https://example.com/fresh",
      statusCode: 200,
      contentType: "text/plain",
      body: "fresh allowed content",
    }));

    const result = await ingestDocumentViaBackend({
      request: createRequest({
        sourceType: "url",
        source: "https://example.com/cached",
        namespace: "web",
        backend: "native",
      }),
      storage,
      fetchUrl,
      networkAllowlist: ["example.com"],
    });

    expect(fetchUrl).toHaveBeenCalledWith("https://example.com/cached");
    expect(result.cached).toBe(false);
    expect(result.document.text).toBe("fresh allowed content");
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

function createRequestWithoutTrust(args: Record<string, unknown>): ToolInvokeRequest {
  const request = createRequest(args) as ToolInvokeRequest & { trustLevel?: unknown };
  delete request.trustLevel;
  return request;
}

function createKnowledgeStorage(seedDocuments: Array<Record<string, unknown>> = []): Storage & AsyncStorage {
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
          embeddingMetadata: entry.embeddingMetadata,
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
  } as unknown as Storage & AsyncStorage;
}

function createPdfBuffer(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

function createPolicyConfig() {
  const config: ToolPolicyConfig = {
    profiles: {
      danger: ["*"],
    },
    tools: {
      profile: "danger",
      approvalMode: "approve_risky",
      allow: [],
      deny: [],
    },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: [],
      networkAllowlist: ["localhost"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  return config;
}

function createPolicyStorage(): Storage & AsyncStorage {
  return {
    toolGrants: {
      list: vi.fn(() => []),
      listActive: vi.fn(() => []),
    },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    pendingApprovalActions: {
      find: vi.fn(() => undefined),
    },
  } as unknown as Storage & AsyncStorage;
}
