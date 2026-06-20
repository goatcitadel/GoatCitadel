import { afterEach, describe, expect, it, vi } from "vitest";
import { currentEmbeddingProfile, generateEmbedding, isEmbeddingCurrent } from "./local-embeddings.js";

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("falls back explicitly when a non-pseudo provider is requested", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote-openai-compatible");

    const generated = await generateEmbedding("fallback profile");

    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      requestedProvider: "remote-openai-compatible",
      status: "fallback",
      source: "environment",
      fallbackReason: "embedding-provider-unavailable: remote-openai-compatible",
    });
    expect(generated.metadata.fallbackReason).toBe("embedding-provider-unavailable: remote-openai-compatible");
  });
});
