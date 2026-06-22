import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentEmbeddingProfile, generateEmbedding, isEmbeddingCurrent } from "./local-embeddings.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local embeddings profile", () => {
  it("uses the default pseudo profile with visible profile metadata", async () => {
    const profile = currentEmbeddingProfile();
    const generated = await generateEmbedding("operator-visible memory");

    expect(profile).toMatchObject({
      profileId: "pseudo:pseudo-hash-v1:64:goatcitadel-embedding-v1",
      provider: "pseudo",
      modelId: "pseudo-hash-v1",
      dimensions: 64,
      status: "active",
      source: "default",
    });
    expect(generated.profile).toEqual(profile);
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata).toMatchObject({
      provider: "pseudo",
      modelId: "pseudo-hash-v1",
      profileId: profile.profileId,
      profileStatus: "active",
      dimensions: 64,
    });
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(true);
  });

  it("supports request-scoped pseudo dimensions and detects stale profile metadata", async () => {
    const request = { provider: "pseudo", modelId: "pseudo-hash-v1-small", dimensions: 16 };
    const generated = await generateEmbedding("short profile", new Date("2026-05-15T12:00:00.000Z"), request);

    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      modelId: "pseudo-hash-v1-small",
      dimensions: 16,
      source: "request",
      status: "active",
    });
    expect(generated.embedding).toHaveLength(16);
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata, request)).toBe(true);
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(false);
  });

  it("falls back explicitly when a non-pseudo provider is requested without config", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote-openai-compatible");

    const generated = await generateEmbedding("fallback profile");

    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      requestedProvider: "remote-openai-compatible",
      status: "fallback",
      source: "environment",
      fallbackReason: "embedding-provider-unavailable: remote-openai-compatible",
    });
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toBe("embedding-provider-unavailable: remote-openai-compatible");
  });
});

describe("local embeddings provider selection", () => {
  it("defaults to pseudo when the env var is unset and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const profile = currentEmbeddingProfile();
    const generated = await generateEmbedding("default selection");

    expect(profile.provider).toBe("pseudo");
    expect(generated.metadata.provider).toBe("pseudo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves an active llamacpp profile when fully configured", () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "nomic-embed-text");

    const profile = currentEmbeddingProfile();
    expect(profile).toMatchObject({
      provider: "llamacpp",
      modelId: "nomic-embed-text",
      dimensions: 8,
      status: "active",
      source: "environment",
      profileId: "llamacpp:nomic-embed-text:8:goatcitadel-embedding-v1",
    });
  });
});

describe("local embeddings real provider", () => {
  const dims = 8;
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", String(dims));
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
  });

  it("uses a llama.cpp endpoint and stamps the real provider profile", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "nomic-embed-text");
    const fetchSpy = vi.fn(async () => jsonResponse({ embedding: vector }));
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("real semantic text", new Date("2026-06-22T00:00:00.000Z"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: "real semantic text" });
    expect(generated.method).toBe("llamacpp-embedding");
    expect(generated.embedding).toHaveLength(dims);
    expect(generated.metadata).toMatchObject({
      provider: "llamacpp",
      modelId: "nomic-embed-text",
      dimensions: dims,
      version: "goatcitadel-embedding-v1",
    });
    expect(generated.metadata.fallbackReason).toBeUndefined();
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(true);
  });

  it("parses an OpenAI-compatible remote response and forwards the model + auth", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "text-embedding-3-small");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_API_KEY", "secret-token");
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ embedding: vector }] }));
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("remote semantic text");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(JSON.parse(String(init.body))).toEqual({ model: "text-embedding-3-small", input: "remote semantic text" });
    expect(generated.method).toBe("remote-embedding");
    expect(generated.metadata.provider).toBe("remote");
    expect(generated.embedding).toHaveLength(dims);
  });

  it("falls back to pseudo on a transport error without throwing", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const generated = await generateEmbedding("network down");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toContain("ECONNREFUSED");
  });

  it("falls back to pseudo on a non-2xx response", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response),
    );

    const generated = await generateEmbedding("server error");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.metadata.fallbackReason).toContain("embedding-http-503");
  });

  it("falls back to pseudo when the provider returns the wrong dimensionality", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embedding: [0.1, 0.2] })),
    );

    const generated = await generateEmbedding("wrong dims");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.metadata.fallbackReason).toContain("embedding-dimension-mismatch");
  });

  it("falls back to pseudo when the response vector is not numeric", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ embedding: ["nope"] }] })),
    );

    const generated = await generateEmbedding("bad vector");

    expect(generated.metadata.provider).toBe("pseudo");
  });

  it("falls back to pseudo (active config) when the URL is missing", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("no url configured");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      status: "fallback",
      requestedProvider: "llamacpp",
      fallbackReason: "embedding-provider-unavailable: llamacpp",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps store and query embeddings dimensionally consistent under a real provider", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ embedding: vector }] })),
    );

    const stored = await generateEmbedding("a memory written at store time");
    const queried = await generateEmbedding("a query issued at retrieve time");

    expect(stored.embedding).toHaveLength(queried.embedding.length);
    expect(stored.embedding.length).toBe(currentEmbeddingProfile().dimensions);
    expect(stored.metadata.provider).toBe(queried.metadata.provider);
    expect(stored.metadata.dimensions).toBe(queried.metadata.dimensions);
  });
});
