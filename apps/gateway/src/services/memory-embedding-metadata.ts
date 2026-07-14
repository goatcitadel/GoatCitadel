import { ConflictError, type MemoryEmbeddingProfileRequest } from "@goatcitadel/contracts";
import {
  EmbeddingUsageSettlementError,
  generateEmbedding,
  type EmbeddingRuntimeOptions,
} from "@goatcitadel/policy-engine";

export type MemoryEmbeddingRuntimeOptions = Omit<EmbeddingRuntimeOptions, "purpose">;

/**
 * Metadata fragment merged into a memory item / structured-memory record so the
 * retrieval ranker can read a content embedding via `extractMemoryEmbedding`
 * (which looks up `metadata.embedding`). `embeddingMetadata` carries the
 * provider/model/version/dimensions so `isEmbeddingCurrent` can later validate
 * the vector against the active profile (W2 swaps in a real provider).
 */
export interface MemoryEmbeddingMetadataFragment extends Record<string, unknown> {
  embedding: number[];
  embeddingMetadata: Record<string, unknown>;
  modelUsageEventIds?: string[];
}

/**
 * Generate a content embedding and return the metadata fragment to merge into a
 * memory write. Always-on (the pseudo provider is ~free); returns `undefined`
 * when the content is empty or generation fails so callers degrade gracefully
 * to a write without an embedding rather than failing the write.
 */
export async function buildMemoryEmbeddingMetadata(
  content: string,
  request?: MemoryEmbeddingProfileRequest,
  runtimeOptions?: MemoryEmbeddingRuntimeOptions,
): Promise<MemoryEmbeddingMetadataFragment | undefined> {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const generated = await generateEmbedding(trimmed, undefined, request, {
      ...runtimeOptions,
      purpose: "memory_write",
    });
    if (!generated.embedding.length) {
      return undefined;
    }
    return {
      embedding: generated.embedding,
      embeddingMetadata: { ...generated.metadata },
      ...(generated.modelUsageEventIds ? { modelUsageEventIds: [...generated.modelUsageEventIds] } : {}),
    };
  } catch (error) {
    if (runtimeOptions?.signal?.aborted) {
      throw runtimeOptions.signal.reason instanceof Error
        ? runtimeOptions.signal.reason
        : new Error("memory embedding generation aborted");
    }
    if (error instanceof ConflictError || error instanceof EmbeddingUsageSettlementError) {
      throw error;
    }
    return undefined;
  }
}

/**
 * Merge a freshly generated embedding fragment into an existing memory
 * `metadata` object without mutating the input. Existing keys win only for
 * non-embedding fields; the embedding fragment is authoritative for `embedding`
 * and `embeddingMetadata` so re-writes refresh the vector.
 */
export async function withMemoryEmbeddingMetadata(
  metadata: Record<string, unknown>,
  content: string,
  request?: MemoryEmbeddingProfileRequest,
  runtimeOptions?: MemoryEmbeddingRuntimeOptions,
): Promise<Record<string, unknown>> {
  const fragment = await buildMemoryEmbeddingMetadata(content, request, runtimeOptions);
  if (!fragment) {
    return { ...metadata };
  }
  return { ...metadata, ...fragment };
}
