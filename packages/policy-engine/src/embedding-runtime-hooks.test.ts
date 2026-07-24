import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { EmbeddingUsageDispatchInput, LocalEmbeddingLeaseRequest } from "./local-embeddings.js";
import { executeTool } from "./tool-executor.js";

const policyConfig: ToolPolicyConfig = {
  profiles: { minimal: [] },
  tools: { profile: "minimal", allow: [], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["127.0.0.1"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("embedding runtime hook propagation", () => {
  it("propagates the tool hook and signal across concurrent memory chunks", async () => {
    configureLlamaCpp();
    const storage = createKnowledgeStorage();
    const controller = new AbortController();
    const acquired: LocalEmbeddingLeaseRequest[] = [];
    let activeLeases = 0;
    let maxActiveLeases = 0;
    let releasedLeases = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return llamaResponse();
      }),
    );

    const result = await executeTool(
      request(
        "memory.write",
        {
          namespace: "project",
          title: "Concurrent chunks",
          content: "x".repeat(3_000),
        },
        controller.signal,
      ),
      policyConfig,
      storage,
      {
        acquireLocalEmbeddingLease: async (leaseRequest) => {
          acquired.push(leaseRequest);
          activeLeases += 1;
          maxActiveLeases = Math.max(maxActiveLeases, activeLeases);
          return {
            release: () => {
              activeLeases -= 1;
              releasedLeases += 1;
            },
          };
        },
      },
    );

    expect(result.chunksSaved).toBeGreaterThan(1);
    expect(acquired).toHaveLength(Number(result.chunksSaved));
    expect(acquired).toEqual(
      acquired.map(() =>
        expect.objectContaining({
          providerId: "llamacpp",
          url: "http://127.0.0.1:8080/embedding",
          purpose: "memory_write",
          signal: controller.signal,
        }),
      ),
    );
    expect(maxActiveLeases).toBeGreaterThan(1);
    expect(releasedLeases).toBe(acquired.length);
    expect(activeLeases).toBe(0);
  });

  it("uses fixed query, repair, and index purposes for knowledge operations", async () => {
    configureLlamaCpp();
    const storage = createKnowledgeStorage();
    const doc = storage.knowledge.createDocument({
      namespace: "project",
      sourceType: "memory",
      sourceRef: "memory:test",
      title: "Unembedded chunks",
      metadata: {},
    });
    storage.knowledge.appendChunks(doc.docId, [{ content: "first" }, { content: "second" }]);
    const signal = new AbortController().signal;
    const purposes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => llamaResponse()),
    );
    const acquireLocalEmbeddingLease = async (leaseRequest: LocalEmbeddingLeaseRequest) => {
      expect(leaseRequest.signal).toBe(signal);
      purposes.push(leaseRequest.purpose);
      return { release: vi.fn() };
    };

    await executeTool(
      request("embeddings.query", { namespace: "project", query: "first" }, signal),
      policyConfig,
      storage,
      { acquireLocalEmbeddingLease },
    );

    expect(purposes).toEqual(["embedding_query", "embedding_repair", "embedding_repair"]);

    purposes.length = 0;
    await executeTool(
      request("embeddings.index", { namespace: "project", force: true }, signal),
      policyConfig,
      storage,
      { acquireLocalEmbeddingLease },
    );

    expect(purposes).toEqual(["embedding_index", "embedding_index"]);
  });

  it("propagates the tool hook into ingestion with a fixed document purpose", async () => {
    configureLlamaCpp();
    const storage = createKnowledgeStorage();
    const signal = new AbortController().signal;
    const acquired: LocalEmbeddingLeaseRequest[] = [];
    let releases = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => llamaResponse()),
    );

    const result = await executeTool(
      request(
        "docs.ingest",
        {
          sourceType: "text",
          source: "operator evidence ".repeat(100),
          namespace: "docs",
          title: "Evidence",
          chunking: { targetChars: 300, overlapChars: 0, maxChunks: 3 },
        },
        signal,
      ),
      policyConfig,
      storage,
      {
        acquireLocalEmbeddingLease: async (leaseRequest) => {
          acquired.push(leaseRequest);
          return {
            release: () => {
              releases += 1;
            },
          };
        },
      },
    );

    const chunksSaved = Number(result.chunksSaved);
    expect(chunksSaved).toBe(3);
    expect(acquired).toHaveLength(chunksSaved);
    expect(acquired.every((item) => item.purpose === "document_ingest" && item.signal === signal)).toBe(true);
    expect(releases).toBe(acquired.length);
  });

  it("gives every document chunk unique canonical lineage and returns the event id union", async () => {
    configureLlamaCpp();
    const storage = createKnowledgeStorage();
    const accounting = createEmbeddingAccountingHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => llamaResponse()),
    );

    const result = await executeTool(
      request("docs.ingest", {
        sourceType: "text",
        source: "canonical document evidence ".repeat(100),
        namespace: "docs",
        title: "Canonical evidence",
        chunking: { targetChars: 300, overlapChars: 0, maxChunks: 3 },
      }),
      policyConfig,
      storage,
      { prepareEmbeddingUsageDispatch: accounting.prepare as never },
    );

    expect(result.chunksSaved).toBe(3);
    expect(accounting.inputs).toHaveLength(3);
    expect(accounting.inputs.map((input) => input.attribution.attemptIndex).sort()).toEqual([0, 1, 2]);
    expect(new Set(accounting.inputs.map((input) => input.attribution.operationId)).size).toBe(1);
    expect(new Set(accounting.inputs.map((input) => input.attribution.dispatchGeneration)).size).toBe(1);
    expect(new Set(accounting.inputs.map((input) => input.attribution.workerId)).size).toBe(3);
    expect(accounting.inputs).toEqual(
      accounting.inputs.map(() =>
        expect.objectContaining({
          source: "embedding_runtime",
          attribution: expect.objectContaining({
            workspaceId: "workspace",
            sessionId: "session",
            agentId: "agent",
            callKind: "embedding",
            utilityKind: "tool:docs.ingest:document_ingest",
          }),
        }),
      ),
    );
    expect(result.modelUsageEventIds).toEqual(["usage-event-1", "usage-event-2", "usage-event-3"]);
  });

  it("fails document ingestion closed when canonical embedding settlement cannot persist", async () => {
    configureLlamaCpp();
    const storage = createKnowledgeStorage();
    const accounting = createEmbeddingAccountingHarness({ failSettlement: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => llamaResponse()),
    );

    await expect(
      executeTool(
        request("docs.ingest", {
          sourceType: "text",
          source: "settlement evidence ".repeat(20),
          namespace: "docs",
          title: "Settlement evidence",
        }),
        policyConfig,
        storage,
        { prepareEmbeddingUsageDispatch: accounting.prepare as never },
      ),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      message: "Embedding usage accounting persistence failed",
    });
    expect(storage.knowledge.appendChunks).not.toHaveBeenCalled();
    expect(accounting.attempts.every((attempt) => attempt.fail.mock.calls.length === 0)).toBe(true);
  });
});

function configureLlamaCpp(): void {
  vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
  vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
  vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
}

function llamaResponse(): Response {
  return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function request(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent",
    sessionId: "session",
    workspaceId: "workspace",
    ...(signal ? { signal } : {}),
  };
}

function createEmbeddingAccountingHarness(options: { failSettlement?: boolean } = {}) {
  const inputs: EmbeddingUsageDispatchInput[] = [];
  const attempts: Array<{
    eventId: string;
    observe: ReturnType<typeof vi.fn>;
    observeNormalized: ReturnType<typeof vi.fn>;
    succeed: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const prepare = vi.fn((input: EmbeddingUsageDispatchInput) => {
    inputs.push(input);
    const eventId = `usage-event-${inputs.length}`;
    const attempt = {
      eventId,
      observe: vi.fn(),
      observeNormalized: vi.fn(),
      succeed: vi.fn(() => {
        if (options.failSettlement) throw new Error("finalizeAndProject failed");
        return { eventId };
      }),
      fail: vi.fn(),
      cancel: vi.fn(),
    };
    attempts.push(attempt);
    return {
      eventId,
      accept: vi.fn(() => attempt),
      abandon: vi.fn(),
      markDispatchUnknown: vi.fn(),
    };
  });
  return { inputs, attempts, prepare };
}

function createKnowledgeStorage(): Storage {
  const documents: Array<Record<string, unknown>> = [];
  const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
  let documentSeq = 0;
  let chunkSeq = 0;

  return {
    knowledge: {
      listDocuments: vi.fn((namespace?: string) =>
        documents.filter((document) => !namespace || document.namespace === namespace),
      ),
      createDocument: vi.fn((input: Record<string, unknown>) => {
        const document = {
          docId: `doc-${++documentSeq}`,
          namespace: input.namespace,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          title: input.title,
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString(),
        };
        documents.unshift(document);
        return document;
      }),
      appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
        const saved = entries.map((entry, index) => ({
          chunkId: `chunk-${++chunkSeq}`,
          docId,
          seq: index,
          content: String(entry.content ?? ""),
          embedding: entry.embedding as number[] | undefined,
          embeddingMetadata: entry.embeddingMetadata as Record<string, unknown> | undefined,
          tokenEstimate: 1,
          createdAt: new Date().toISOString(),
        }));
        chunksByDocId.set(docId, [...(chunksByDocId.get(docId) ?? []), ...saved]);
        return saved;
      }),
      listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
      listChunksByNamespace: vi.fn((namespace?: string) => {
        const matchingDocIds = documents
          .filter((document) => !namespace || document.namespace === namespace)
          .map((document) => String(document.docId));
        return matchingDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
      }),
      updateChunkEmbedding: vi.fn(
        (chunkId: string, embedding: number[], embeddingMetadata?: Record<string, unknown>) => {
          for (const chunks of chunksByDocId.values()) {
            const chunk = chunks.find((entry) => entry.chunkId === chunkId);
            if (chunk) {
              chunk.embedding = embedding;
              chunk.embeddingMetadata = embeddingMetadata;
              return chunk;
            }
          }
          return undefined;
        },
      ),
    },
  } as unknown as Storage;
}
