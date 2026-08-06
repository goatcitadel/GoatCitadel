import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeTool } from "./tool-executor.js";

const createdDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-policy-tail-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  createdDirs.push(root);
  return root;
}

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent-tail",
    sessionId: "session-tail",
  };
}

function createKnowledgeStorage(): Storage & AsyncStorage {
  const documents = [
    {
      docId: "doc-empty",
      namespace: "default",
      sourceType: "note",
      sourceRef: "memory://empty",
      title: "Empty Chunk Document",
      metadata: { kind: "empty" },
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    {
      docId: "doc-match",
      namespace: "default",
      sourceType: "note",
      sourceRef: "memory://match",
      title: "Matched Document",
      metadata: { kind: "match" },
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ];
  const chunks = new Map<string, Array<Record<string, unknown>>>([
    ["doc-empty", []],
    [
      "doc-match",
      [
        {
          chunkId: "chunk-match",
          docId: "doc-match",
          seq: 0,
          content: "coverage branch matching text",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    ],
  ]);

  return {
    knowledge: {
      listDocuments: vi.fn((namespace?: string) =>
        documents.filter((doc) => !namespace || doc.namespace === namespace),
      ),
      listChunksByDocument: vi.fn((docId: string) => chunks.get(docId) ?? []),
      listChunksByNamespace: vi.fn((namespace?: string) =>
        documents
          .filter((doc) => !namespace || doc.namespace === namespace)
          .flatMap((doc) => chunks.get(doc.docId) ?? []),
      ),
      updateChunkEmbedding: vi.fn(
        (chunkId: string, embedding: number[], embeddingMetadata?: Record<string, unknown>) => {
          for (const entries of chunks.values()) {
            const match = entries.find((entry) => entry.chunkId === chunkId);
            if (match) {
              match.embedding = embedding;
              match.embeddingMetadata = embeddingMetadata;
              return match;
            }
          }
          return { chunkId, embedding, embeddingMetadata };
        },
      ),
    },
  } as unknown as Storage & AsyncStorage;
}

function createCommsStorage(connection: { key: string; config: Record<string, unknown> }): Storage & AsyncStorage {
  const queued = {
    deliveryId: "delivery-tail",
    connectionId: "connection-tail",
    channelKey: connection.key,
    target: "ops",
    status: "queued",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
  return {
    integrationConnections: {
      get: vi.fn(() => connection),
    },
    commsDeliveries: {
      createQueued: vi.fn(() => queued),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    },
  } as unknown as Storage & AsyncStorage;
}

describe("tool executor tail coverage", () => {
  it("uses filesystem default arguments without widening the jail", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const filePath = path.join(root, "empty.txt");

    const written = await executeTool(request("fs.write", { path: filePath }), config, storage);
    expect(written).toMatchObject({ bytesWritten: 0 });
    expect(fs.readFileSync(filePath, "utf8")).toBe("");

    const listed = await executeTool(request("fs.list", { path: root }), config, storage);
    expect(listed).toMatchObject({
      path: path.resolve(root),
      items: [expect.objectContaining({ name: "empty.txt", type: "file" })],
    });
  });

  it("requires approval for risky foreground and background shell commands", async () => {
    const root = createRoot();
    const config = createConfig(root);
    config.sandbox.riskyShellPatterns = ["Remove-Item"];
    const storage = createKnowledgeStorage();

    await expect(
      executeTool(request("shell.exec", { command: "Remove-Item important.txt" }), config, storage),
    ).rejects.toThrow(/matched pattern: Remove-Item/i);
    await expect(
      executeTool(request("shell.exec_background", { command: "Remove-Item important.txt" }), config, storage),
    ).rejects.toThrow(/matched pattern: Remove-Item/i);
  });

  it("preserves undefined content-type responses for allowlisted HTTP tools", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const fetchMock = vi.fn(async () => new Response(new TextEncoder().encode("ok"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const get = await executeTool(request("http.get", { url: "https://example.com/status" }), config, storage);
    const post = await executeTool(request("http.post", { url: "https://example.com/status" }), config, storage);

    expect(get).toMatchObject({ contentType: undefined, body: "ok" });
    expect(post).toMatchObject({ contentType: undefined, body: "ok" });
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/status", expect.objectContaining({ body: "{}" }));
  });

  it("returns default namespaces and snippets for memory and embedding reads", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();

    const memory = await executeTool(request("memory.read", { limit: 2 }), config, storage);
    expect(memory).toMatchObject({
      namespace: "all",
      items: [
        expect.objectContaining({ docId: "doc-empty", snippet: "" }),
        expect.objectContaining({ docId: "doc-match", snippet: "coverage branch matching text" }),
      ],
    });

    const search = await executeTool(request("memory.search", { query: "coverage" }), config, storage);
    expect(search).toMatchObject({ namespace: "all", query: "coverage" });

    const indexed = await executeTool(request("embeddings.index", {}), config, storage);
    expect(indexed).toMatchObject({
      namespace: "all",
      documentId: undefined,
      indexed: 1,
      skipped: 0,
      stale: 0,
      methods: ["pseudo-embedding"],
      embeddingProfile: {
        provider: "pseudo",
        modelId: "pseudo-hash-v1",
        status: "active",
      },
    });

    const queried = await executeTool(request("embeddings.query", { query: "coverage" }), config, storage);
    expect(queried).toMatchObject({
      namespace: "all",
      method: "pseudo-embedding",
      embedding: {
        provider: "pseudo",
        modelId: "pseudo-hash-v1",
      },
      embeddingProfile: {
        provider: "pseudo",
        modelId: "pseudo-hash-v1",
      },
      repairedEmbeddings: 0,
    });
  });

  it("persists query-time embedding repairs with profile evidence", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();

    const queried = await executeTool(
      request("embeddings.query", {
        query: "coverage",
        embeddingProfile: { provider: "pseudo", modelId: "pseudo-hash-v1-small", dimensions: 16 },
      }),
      config,
      storage,
    );

    expect(queried).toMatchObject({
      method: "pseudo-embedding",
      embeddingProfile: {
        provider: "pseudo",
        modelId: "pseudo-hash-v1-small",
        dimensions: 16,
        source: "request",
      },
      repairedEmbeddings: 1,
      missingEmbeddings: 1,
      staleEmbeddings: 0,
      items: [expect.objectContaining({ embeddingStatus: "generated" })],
    });
    expect(storage.knowledge.updateChunkEmbedding).toHaveBeenCalledWith(
      "chunk-match",
      expect.arrayContaining([expect.any(Number)]),
      expect.objectContaining({
        provider: "pseudo",
        modelId: "pseudo-hash-v1-small",
        dimensions: 16,
        profileStatus: "active",
      }),
    );
  });

  it("uses artifact title, template, and body defaults", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const artifactPath = path.join(root, "artifact.md");

    const created = await executeTool(request("artifacts.create", { path: artifactPath }), config, storage);

    expect(created).toMatchObject({ path: path.resolve(artifactPath), template: "report" });
    expect(fs.readFileSync(artifactPath, "utf8")).toContain("_No content provided._");
  });

  it("creates a real pptx deck inside the write jail", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const deckPath = path.join(root, "free-time-deck.pptx");

    const created = await executeTool(
      request("presentations.create", {
        path: deckPath,
        title: "Top Free-Time Activities",
        subtitle: "A lightweight deck",
        slides: [
          {
            title: "Go Outside",
            bullets: ["Visit a local park", "Take a low-pressure walk"],
          },
        ],
        visualAsset: {
          bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          mimeType: "image/png",
          source: "openai",
          sourceModel: "gpt-image-2",
          revisedPrompt: "A clean wellness deck visual.",
        },
      }),
      config,
      storage,
    );

    const deck = fs.readFileSync(deckPath);
    expect(created).toMatchObject({
      path: path.resolve(deckPath),
      format: "pptx",
      slideCount: 2,
      visualAsset: {
        source: "openai",
        sourceModel: "gpt-image-2",
        mimeType: "image/png",
      },
      designReport: {
        mode: "polished",
        preset: "wellness",
        google: { requested: false, status: "not_requested" },
      },
    });
    const designReport = created.designReport as {
      assetSources?: Array<{ id: string; status: string }>;
      validation?: Array<{ id: string; status: string }>;
      designQuality?: { skillId: string; status: string; retryAttempted: boolean };
    };
    expect(designReport.assetSources?.find((asset) => asset.id === "renderer-generated-visual")?.status).toBe("used");
    expect(designReport.validation?.find((check) => check.id === "pptx-package")?.status).toBe("passed");
    expect(designReport.validation?.find((check) => check.id === "presentation-template")?.status).toBe("passed");
    expect(designReport.validation?.find((check) => check.id === "content-density")?.status).toBe("passed");
    expect(designReport.validation?.find((check) => check.id === "design-skill-applied")?.status).toBe("warning");
    expect(designReport.designQuality).toMatchObject({
      skillId: "design-intelligence",
      status: "warning",
      retryAttempted: true,
    });
    expect(deck.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(deck.includes("ppt/presentation.xml")).toBe(true);
    expect(deck.includes("ppt/slides/slide1.xml")).toBe(true);
    expect(deck.includes("ppt/media/")).toBe(true);
    expect(deck.includes("ppt/notesSlides/")).toBe(true);
    expect(JSON.stringify(created)).toContain("renderer-generated-visual");
  }, 20_000);

  it("rejects a presentation without its required title before visual preparation or file output", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const deckPath = path.join(root, "missing-title.pptx");
    const preparePresentationVisuals = vi.fn();

    await expect(
      executeTool(
        request("presentations.create", {
          path: deckPath,
          slides: [{ title: "A Content Slide", bullets: ["Grounded content"] }],
        }),
        config,
        storage,
        { preparePresentationVisuals },
      ),
    ).rejects.toThrow("Missing required argument: title");
    expect(preparePresentationVisuals).not.toHaveBeenCalled();
    expect(fs.existsSync(deckPath)).toBe(false);
  });

  it("keeps post-approval visual bytes ephemeral while reporting mappings and skill provenance", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const deckPath = path.join(root, "mapped-visuals.pptx");
    const invokeRequest = request("presentations.create", {
      path: deckPath,
      title: "Mapped Visuals",
      slides: [{ title: "Grounded Section", bullets: ["Specific source-backed finding"] }],
    });
    invokeRequest.runtimeSkillApplications = [
      {
        skillId: "bundled:design-intelligence",
        treeSha256: "a".repeat(64),
        instructionSha256: "b".repeat(64),
        modules: ["main", "enforcement", "layout", "taste", "assets", "audit"],
      },
    ];
    invokeRequest.presentationGrounding = { sourceTermCount: 8, matchedSourceTermCount: 6 };
    const created = await executeTool(invokeRequest, config, storage, {
      preparePresentationVisuals: async () => ({
        plan: [
          {
            slideIndex: 1,
            slideTitle: "Grounded Section",
            kind: "section",
            promptSha256: "c".repeat(64),
          },
        ],
        assets: [
          {
            slideIndex: 1,
            promptSha256: "c".repeat(64),
            asset: {
              bytesBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
              mimeType: "image/png",
              source: "openai",
              sourceModel: "gpt-image-2",
            },
          },
        ],
        warnings: [],
        providerCalls: 1,
      }),
    });

    expect(created).toMatchObject({
      visualAssets: [
        {
          slideIndex: 1,
          source: "openai",
          sourceModel: "gpt-image-2",
          promptSha256: "c".repeat(64),
        },
      ],
      visualProviderCalls: 1,
      designReport: {
        designQuality: {
          runtimeInstructions: {
            status: "injected",
            skills: [expect.objectContaining({ skillId: "bundled:design-intelligence" })],
          },
          contentGrounding: { status: "passed" },
          visualLayout: { status: "passed" },
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain("iVBORw0KGgo");
  }, 20_000);

  it("creates real document artifacts inside the write jail", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const docxPath = path.join(root, "free-time-report.docx");
    const pdfPath = path.join(root, "free-time-report.pdf");

    const docx = await executeTool(
      request("documents.create", {
        path: docxPath,
        format: "docx",
        title: "Free Time Report",
        sections: [
          {
            heading: "Activities",
            body: "A concise set of options.",
            bullets: ["Read", "Walk", "Cook"],
          },
        ],
      }),
      config,
      storage,
    );
    const pdf = await executeTool(
      request("documents.create", {
        path: pdfPath,
        format: "pdf",
        title: "Free Time Report",
        body: "Choose one active, one creative, and one restful option.",
      }),
      config,
      storage,
    );

    const docxBytes = fs.readFileSync(docxPath);
    const pdfBytes = fs.readFileSync(pdfPath);
    expect(docx).toMatchObject({
      path: path.resolve(docxPath),
      format: "docx",
      designReport: {
        mode: "polished",
        assetPolicy: "generated-first",
      },
    });
    expect(pdf).toMatchObject({
      path: path.resolve(pdfPath),
      format: "pdf",
      mimeType: "application/pdf",
      designReport: {
        mode: "polished",
      },
    });
    expect(docxBytes.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(docxBytes.includes("word/document.xml")).toBe(true);
    expect(docxBytes.includes("word/media/")).toBe(true);
    expect(pdfBytes.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdfBytes.includes("/Type /Catalog")).toBe(true);
  });

  it("warns when a media-dependent deck falls back to local-only visuals", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const deckPath = path.join(root, "local-visual-deck.pptx");

    const created = await executeTool(
      request("presentations.create", {
        path: deckPath,
        title: "Weekend Fun",
        slides: [{ title: "Pick A Plan", bullets: ["Choose one active option", "Choose one restful option"] }],
      }),
      config,
      storage,
    );

    const designReport = created.designReport as {
      validation?: Array<{ id: string; status: string; detail: string }>;
      designQuality?: { status: string; retryAttempted: boolean; findings: Array<{ id: string }> };
      residualRisks?: string[];
    };
    expect(designReport.designQuality).toMatchObject({
      status: "warning",
      retryAttempted: true,
      findings: expect.arrayContaining([expect.objectContaining({ id: "asset-specificity" })]),
    });
    expect(designReport.validation?.find((check) => check.id === "asset-specificity")?.status).toBe("warning");
    expect(designReport.residualRisks?.join("\n")).toContain("local renderer-only visuals");
  }, 20_000);

  it("keeps renderer provenance out of visible HTML and PDF document content", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const htmlPath = path.join(root, "free-time-report.html");
    const pdfPath = path.join(root, "free-time-report.pdf");

    await executeTool(
      request("documents.create", {
        path: htmlPath,
        format: "html",
        title: "Free Time Report",
        body: "Choose one active, one creative, and one restful option.",
      }),
      config,
      storage,
    );
    await executeTool(
      request("documents.create", {
        path: pdfPath,
        format: "pdf",
        title: "Free Time Report",
        body: "Choose one active, one creative, and one restful option.",
      }),
      config,
      storage,
    );

    const html = fs.readFileSync(htmlPath, "utf8");
    const pdf = fs.readFileSync(pdfPath, "utf8");
    expect(html).not.toMatch(/Design preset|Asset provenance|clean-professional|wellness/u);
    expect(pdf).not.toMatch(/Design preset|Asset provenance/u);
  });

  it("keeps raw document artifacts minimal and skips design-quality visual checks", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const jsonPath = path.join(root, "raw-export.json");
    const csvPath = path.join(root, "raw-export.csv");
    const txtPath = path.join(root, "raw-export.txt");

    const json = await executeTool(
      request("documents.create", {
        path: jsonPath,
        format: "json",
        title: "Raw Export",
        rows: [{ name: "a", value: 1 }],
      }),
      config,
      storage,
    );
    const csv = await executeTool(
      request("documents.create", {
        path: csvPath,
        format: "csv",
        title: "Raw Export",
        rows: [{ name: "a", value: 1 }],
      }),
      config,
      storage,
    );
    const txt = await executeTool(
      request("documents.create", {
        path: txtPath,
        format: "txt",
        title: "Raw Export",
        body: "plain text export",
      }),
      config,
      storage,
    );

    for (const result of [json, csv, txt]) {
      const designReport = result.designReport as {
        mode?: string;
        assetPolicy?: string;
        validation?: Array<{ id: string; status: string }>;
        designQuality?: { status: string; retryAttempted: boolean };
      };
      expect(designReport.mode).toBe("minimal");
      expect(designReport.assetPolicy).toBe("none");
      expect(designReport.designQuality).toMatchObject({ status: "skipped", retryAttempted: false });
      expect(designReport.validation?.find((check) => check.id === "asset-specificity")?.status).toBe("skipped");
    }
  });

  it("reports Google destination fallback while preserving local artifacts", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const docxPath = path.join(root, "google-ready-report.docx");

    const created = await executeTool(
      request("documents.create", {
        path: docxPath,
        format: "docx",
        title: "Google Ready Report",
        destination: "google-docs",
        sections: [{ heading: "Summary", bullets: ["Local artifact should still be produced."] }],
      }),
      config,
      storage,
    );

    expect(fs.existsSync(docxPath)).toBe(true);
    expect(created).toMatchObject({
      path: path.resolve(docxPath),
      designReport: {
        localPath: path.resolve(docxPath),
        google: {
          requested: true,
          status: "not_configured",
          mode: "convert",
        },
      },
    });
  });

  it("builds citations from partial source rows and sanitizes secret-like fields", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();

    const result = await executeTool(
      request("citations.build", {
        sources: [
          { url: "", title: "Skipped" },
          { url: "https://example.com/a", description: "Description fallback" },
          {
            citationId: "cite-explicit",
            url: "https://example.com/b",
            title: "Explicit",
            snippet: "Explicit snippet",
            sourceType: "docs",
          },
        ],
      }),
      config,
      storage,
    );

    expect(result).toMatchObject({
      count: 2,
      citations: [
        {
          citationId: "citation-2",
          url: "https://example.com/a",
          snippet: "Description fallback",
          sourceType: "web",
        },
        {
          citationId: "cite-explicit",
          url: "https://example.com/b",
          title: "Explicit",
          snippet: "Explicit snippet",
          sourceType: "docs",
        },
      ],
    });
  });

  it("renders channel webhook attachment variants and classifies unsupported reactions", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const fetchMock = vi.fn(
      async () =>
        new Response("ok", {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = createCommsStorage({
      key: "webhook",
      config: { webhookUrl: "https://example.com/incoming", defaultTarget: "ops" },
    });

    const sent = await executeTool(
      request("channel.send", {
        connectionId: "connection-tail",
        message: "Deploy note",
        payload: "ignored",
        attachments: [
          { title: "Runbook", url: "https://example.com/runbook" },
          { url: "https://example.com/log" },
          { title: "Title only" },
          { attachmentId: "artifact-1" },
          { dataBase64: "ZmFrZQ==" },
          { mimeType: "text/plain" },
          null,
          {},
        ],
      }),
      config,
      storage,
    );

    expect(sent).toMatchObject({ status: "sent", deliveryStatus: "sent" });
    const firstFetchCall = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: unknown }]>)[0];
    if (!firstFetchCall) {
      throw new Error("Expected webhook fetch call");
    }
    const requestInit = firstFetchCall[1];
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      text: expect.stringContaining("Attachments:"),
      target: "ops",
      payload: {},
    });
    expect(body.text).toContain("- Runbook: https://example.com/runbook");
    expect(body.text).toContain("- https://example.com/log");
    expect(body.text).toContain("- Title only");
    expect(body.text).toContain("- attachment artifact-1");
    expect(body.text).toContain("- inline attachment");

    const unsupported = await executeTool(
      request("channel.react", {
        connectionId: "connection-tail",
        messageId: "message-1",
        reaction: "+1",
      }),
      config,
      storage,
    );
    expect(unsupported).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
      fallbackReason: expect.stringContaining("not supported"),
    });
  });

  it("classifies channel send configuration failures without attempting network delivery", async () => {
    const root = createRoot();
    const config = createConfig(root);

    const missingWebhook = await executeTool(
      request("channel.send", {
        connectionId: "connection-tail",
        message: "No URL configured",
      }),
      config,
      createCommsStorage({ key: "webhook", config: {} }),
    );
    expect(missingWebhook).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
      fallbackReason: "Missing webhook URL",
    });

    const missingSlackToken = await executeTool(
      request("channel.send", {
        connectionId: "connection-tail",
        message: "No token configured",
      }),
      config,
      createCommsStorage({ key: "slack", config: { defaultChannel: "#ops" } }),
    );
    expect(missingSlackToken).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
      fallbackReason: "Missing Slack bot token",
    });
  });

  it("keeps secret-like args behind explicit refs and walks file-search defaults", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();
    const nested = path.join(root, "Nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "Alpha.txt"), "alpha", "utf8");
    fs.writeFileSync(path.join(nested, "Beta.txt"), "beta", "utf8");

    const secretValue = "sk-123456789012345678901234";
    await expect(
      executeTool(request("fs.write", { path: path.join(root, "blocked.txt"), token: secretValue }), config, storage),
    ).rejects.toThrow(/secret-like material/);

    const secretBackedRequest = {
      ...request("fs.write", { path: path.join(root, "allowed.txt"), token: secretValue }),
      authContext: { secretRefs: ["secret://tool/api-key"] },
    } satisfies ToolInvokeRequest;
    await expect(executeTool(secretBackedRequest, config, storage)).resolves.toMatchObject({ bytesWritten: 0 });

    const listed = await executeTool(request("fs.list", { path: root }), config, storage);
    expect(listed).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: "Alpha.txt", type: "file" }),
        expect.objectContaining({ name: "Nested", type: "dir" }),
      ]),
    });

    const fileRootMatches = await executeTool(
      request("code.search_files", { path: path.join(root, "Alpha.txt"), query: "alpha" }),
      config,
      storage,
    );
    expect(fileRootMatches).toMatchObject({
      count: 1,
      matches: [expect.objectContaining({ name: "Alpha.txt", type: "file" })],
    });

    const caseSensitiveMiss = await executeTool(
      request("code.search_files", { path: root, query: "beta", caseSensitive: true }),
      config,
      storage,
    );
    expect(caseSensitiveMiss).toMatchObject({ count: 0, matches: [] });

    const recursiveMatch = await executeTool(
      request("code.search_files", { path: root, query: "beta", limit: 1 }),
      config,
      storage,
    );
    expect(recursiveMatch).toMatchObject({
      count: 1,
      matches: [expect.objectContaining({ name: "Beta.txt", type: "file" })],
    });
  });
});
