import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
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

function createKnowledgeStorage(): Storage {
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
      updateChunkEmbedding: vi.fn((chunkId: string, embedding: number[]) => ({ chunkId, embedding })),
    },
  } as unknown as Storage;
}

function createCommsStorage(connection: { key: string; config: Record<string, unknown> }): Storage {
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
  } as unknown as Storage;
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

  it("keeps optional Bankr built-ins gated when the migration flag disables them", async () => {
    const root = createRoot();
    const config = createConfig(root);
    const storage = createKnowledgeStorage();

    await expect(executeTool(request("bankr.status"), config, storage, { bankrBuiltinEnabled: false })).rejects.toThrow(
      /Bankr built-in is disabled/i,
    );
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
    const fetchMock = vi.fn(
      async () =>
        ({
          status: 200,
          headers: { get: () => null },
          text: async () => "ok",
        }) as unknown as Response,
    );
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
    expect(indexed).toMatchObject({ namespace: "all", documentId: undefined, indexed: 1 });

    const queried = await executeTool(request("embeddings.query", { query: "coverage" }), config, storage);
    expect(queried).toMatchObject({ namespace: "all", method: "pseudo-embedding" });
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
      deliveryStatus: "degraded",
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
