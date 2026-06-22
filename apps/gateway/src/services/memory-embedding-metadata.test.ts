import { describe, expect, it } from "vitest";
import { buildMemoryEmbeddingMetadata, withMemoryEmbeddingMetadata } from "./memory-embedding-metadata.js";

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
});
