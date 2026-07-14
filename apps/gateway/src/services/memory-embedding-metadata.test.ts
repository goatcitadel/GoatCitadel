import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { EmbeddingUsageSettlementError } from "@goatcitadel/policy-engine";
import { buildMemoryEmbeddingMetadata, withMemoryEmbeddingMetadata } from "./memory-embedding-metadata.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("memory embedding metadata (W1 store wiring)", () => {
  it("builds an embedding fragment in the extractMemoryEmbedding shape", async () => {
    const fragment = await buildMemoryEmbeddingMetadata("Browser sessions require scoped grants.");
    expect(fragment).toBeDefined();
    // extractMemoryEmbedding reads `metadata.embedding` as a finite numeric array.
    expect(Array.isArray(fragment?.embedding)).toBe(true);
    expect(fragment?.embedding.length).toBeGreaterThan(0);
    expect(fragment?.embedding.every((value) => Number.isFinite(value))).toBe(true);
    // embeddingMetadata carries the provider/model/version/dimensions for isEmbeddingCurrent.
    expect(fragment?.embeddingMetadata).toMatchObject({
      provider: "pseudo",
      dimensions: fragment?.embedding.length,
    });
  });

  it("returns undefined for empty content (no embedding written)", async () => {
    expect(await buildMemoryEmbeddingMetadata("   ")).toBeUndefined();
    expect(await buildMemoryEmbeddingMetadata("")).toBeUndefined();
  });

  it("merges the embedding into metadata without mutating the input", async () => {
    const original = { tags: ["browser"], retrievalHints: ["external research"] };
    const merged = await withMemoryEmbeddingMetadata(original, "Scoped grants gate browser tool access.");

    expect(merged).toMatchObject({ tags: ["browser"], retrievalHints: ["external research"] });
    expect(Array.isArray(merged.embedding)).toBe(true);
    expect((merged.embedding as number[]).length).toBeGreaterThan(0);
    expect(merged.embeddingMetadata).toBeDefined();
    // Immutability: original untouched.
    expect(original).toEqual({ tags: ["browser"], retrievalHints: ["external research"] });
    expect("embedding" in original).toBe(false);
  });

  it("preserves existing metadata when content is empty", async () => {
    const original = { tags: ["browser"] };
    const merged = await withMemoryEmbeddingMetadata(original, "");
    expect(merged).toEqual({ tags: ["browser"] });
    expect("embedding" in merged).toBe(false);
  });

  it("holds a memory-write lease across a llama.cpp embedding request", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const release = vi.fn();
    const acquireLocalServiceLease = vi.fn(async () => ({ release }));

    const fragment = await buildMemoryEmbeddingMetadata("Lease this structured-memory write.", undefined, {
      acquireLocalServiceLease,
    });

    expect(acquireLocalServiceLease).toHaveBeenCalledWith({
      providerId: "llamacpp",
      url: "http://127.0.0.1:8080/embedding",
      purpose: "memory_write",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(fragment?.embeddingMetadata).toMatchObject({ provider: "llamacpp", dimensions: 8 });
  });

  it("keeps the memory-write purpose fixed for untyped runtime options", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const release = vi.fn();
    const acquireLocalServiceLease = vi.fn(async () => ({ release }));
    const untypedRuntimeOptions = {
      acquireLocalServiceLease,
      purpose: "embedding_query",
    } as unknown as Parameters<typeof buildMemoryEmbeddingMetadata>[2];

    await buildMemoryEmbeddingMetadata("Do not let callers relabel this write.", undefined, untypedRuntimeOptions);

    expect(acquireLocalServiceLease).toHaveBeenCalledWith({
      providerId: "llamacpp",
      url: "http://127.0.0.1:8080/embedding",
      purpose: "memory_write",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not hide a config-generation lease conflict as missing metadata", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    const conflict = new ConflictError({ message: "runtime owners are reconciling" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      buildMemoryEmbeddingMetadata("Fenced structured-memory write.", undefined, {
        acquireLocalServiceLease: async () => Promise.reject(conflict),
      }),
    ).rejects.toBe(conflict);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retains canonical usage-event provenance on governed memory writes", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "embed-requested");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_API_KEY", "secret-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const succeed = vi.fn(() => ({ eventId: "usage-memory-write-1" }));
    const prepareModelUsageDispatch = vi.fn(() => ({
      eventId: "usage-memory-write-1",
      accept: () => ({
        eventId: "usage-memory-write-1",
        observe: vi.fn(),
        observeNormalized: vi.fn(),
        succeed,
        fail: vi.fn(() => ({ eventId: "usage-memory-write-1" })),
        cancel: vi.fn(() => ({ eventId: "usage-memory-write-1" })),
      }),
      abandon: vi.fn(),
      markDispatchUnknown: vi.fn(),
    }));

    const fragment = await buildMemoryEmbeddingMetadata("Durably linked memory embedding.", undefined, {
      prepareModelUsageDispatch,
      modelUsageAttribution: {
        operationId: "memory-entity:entity-1:embedding",
        dispatchGeneration: "initial-write",
        workspaceId: "workspace-1",
      },
    });

    expect(succeed).toHaveBeenCalledTimes(1);
    expect(fragment?.modelUsageEventIds).toEqual(["usage-memory-write-1"]);
    expect(prepareModelUsageDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: expect.objectContaining({
          operationId: "memory-entity:entity-1:embedding",
          dispatchGeneration: "initial-write",
          workspaceId: "workspace-1",
          callKind: "embedding",
          utilityKind: "memory_write",
        }),
      }),
    );
  });

  it("fails closed when canonical terminal settlement cannot be persisted", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const persistenceError = new Error("terminal write failed");

    await expect(
      buildMemoryEmbeddingMetadata("Settlement must remain visible.", undefined, {
        prepareModelUsageDispatch: () => ({
          eventId: "usage-unsettled-1",
          accept: () => ({
            eventId: "usage-unsettled-1",
            observe: vi.fn(),
            observeNormalized: vi.fn(),
            succeed: () => {
              throw persistenceError;
            },
            fail: vi.fn(() => ({ eventId: "usage-unsettled-1" })),
            cancel: vi.fn(() => ({ eventId: "usage-unsettled-1" })),
          }),
          abandon: vi.fn(),
          markDispatchUnknown: vi.fn(),
        }),
      }),
    ).rejects.toMatchObject<Partial<EmbeddingUsageSettlementError>>({
      name: "EmbeddingUsageSettlementError",
      cause: persistenceError,
    });
  });
});
